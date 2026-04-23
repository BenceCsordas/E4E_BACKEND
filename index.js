import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import fs from "node:fs";
import dotenv from "dotenv";
import multer from "multer";
import axios from "axios";
import { v2 as cloudinary } from 'cloudinary'; 

dotenv.config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});
let serviceAccount;

try {
  if (process.env.SERVICE_ACCOUNT_KEY) {
    const rawKey = process.env.SERVICE_ACCOUNT_KEY.trim();
    
    serviceAccount = JSON.parse(rawKey);
    
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
  } else {
    const keyPath = new URL("./serviceAccountKey.json", import.meta.url);
    serviceAccount = JSON.parse(fs.readFileSync(keyPath, "utf8"));
  }
} catch (error) {
  console.error("KRITIKUS: Firebase kulcs hiba:", error.message);
}

if (!admin.apps.length && serviceAccount) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("Firebase sikeresen inicializálva!");
  } catch (initError) {
    console.error("Firebase init hiba:", initError.message);
  }
}

const db = admin.firestore();
const auth = admin.auth();

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(cors({
  origin: [
    "http://localhost:3000",
    "http://localhost:5173",
    "https://events4everyone.netlify.app" 
  ],
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true
}));

app.use(express.json());

const port = 8000;
const USERS = "users";
const EVENTS = "events";
const REGISTRATIONS = "registrations";

const upload = multer({ storage: multer.memoryStorage() });

// yyyy.mm.dd
const dateRegex = /^\d{4}\.\d{2}\.\d{2}$/;
// hh:mm
const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isNonEmptyString(x) {
  return typeof x === "string" && x.trim().length > 0;
}

function isValidDate(date) {
  return date !== undefined && date !== null && dateRegex.test(date);
}

function isValidTime(time) {
  return time !== undefined && time !== null && timeRegex.test(time);
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing Authorization Bearer token" });
  try {
    req.user = await auth.verifyIdToken(token);
    return next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token", details: e.message });
  }
}

// -------------------- IMAGE --------------------

app.post("/api/uploadImage", requireAuth, upload.single("image"), async (req, res) => {
  try {
    const apiKey = process.env.IMGBB_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing IMGBB_API_KEY in .env" });
    if (!req.file) return res.status(400).json({ error: "Missing image file (field name: image)" });

    const base64 = req.file.buffer.toString("base64");
    const params = new URLSearchParams();
    params.append("key", apiKey);
    params.append("image", base64);

    const response = await axios.post("https://api.imgbb.com/1/upload", params, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      maxBodyLength: Infinity,
    });

    const data = response.data?.data;
    if (!data?.url) return res.status(500).json({ error: "imgbb upload failed" });

    res.status(200).json({ url: data.url, delete_url: data.delete_url || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/deleteImage", requireAuth, async (req, res) => {
  try {
    const { delete_url } = req.body;
    if (!isNonEmptyString(delete_url)) return res.status(400).json({ error: "delete_url is required" });
    await axios.get(delete_url.trim());
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -------------------- USERS --------------------

app.get("/users", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    const snapshot = await db.collection(USERS).orderBy("name").limit(limit).get();
    const users = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json({ count: users.length, users, limit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/users/me", requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const doc = await db.collection(USERS).doc(uid).get();
    if (!doc.exists) return res.status(404).json({ error: "User profile not found" });
    res.status(200).json({ id: doc.id, ...doc.data() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/users/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!isNonEmptyString(name)) return res.status(400).json({ error: "name is required" });
    if (!isNonEmptyString(email) || !email.includes("@")) return res.status(400).json({ error: "valid email is required" });
    if (!isNonEmptyString(password) || password.length < 6) return res.status(400).json({ error: "password must be at least 6 characters" });

    const userRecord = await auth.createUser({ email: email.trim(), password, displayName: name.trim() });
    await db.collection(USERS).doc(userRecord.uid).set({
      name: name.trim(),
      email: email.trim(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.status(201).json({ ok: true, uid: userRecord.uid });
  } catch (e) {
    if (e?.code === "auth/email-already-exists") return res.status(409).json({ error: "Email already exists" });
    res.status(500).json({ error: e.message });
  }
});
app.put("/users/me", requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { name, photoURL } = req.body; // Kiterjesztve a photoURL-el

    // Összeállítjuk a frissítendő adatokat a Firestore-hoz
    const updates = { 
      updatedAt: admin.firestore.FieldValue.serverTimestamp() 
    };

    // Összeállítjuk a frissítendő adatokat a Firebase Auth-hoz
    const authUpdates = {};

    if (isNonEmptyString(name)) {
      updates.name = name.trim();
      authUpdates.displayName = name.trim();
    }

    // Ha érkezett photoURL, hozzáadjuk a frissítéshez
    if (isNonEmptyString(photoURL)) {
      updates.photoURL = photoURL.trim();
      authUpdates.photoURL = photoURL.trim();
    }

    // Ha nincs mit frissíteni, hibát dobunk (vagy csak simán visszatérünk)
    if (Object.keys(updates).length <= 1) {
      return res.status(400).json({ error: "Nincs megadva módosítandó adat (név vagy fotó)" });
    }

    // 1. Frissítés a Firestore adatbázisban
    await db.collection(USERS).doc(uid).update(updates);

    // 2. Frissítés a Firebase Authentication-ben
    if (Object.keys(authUpdates).length > 0) {
      await auth.updateUser(uid, authUpdates);
    }

    res.status(200).json({ ok: true, msg: "Sikeres módosítás" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/users/me/ensure", requireAuth, async (req, res) => {
  try {
    const { uid, email, name } = req.user;
    const ref = db.collection(USERS).doc(uid);
    const snap = await ref.get();
    const displayName =
      (typeof req.body?.name === "string" && req.body.name.trim()) ||
      (typeof name === "string" && name.trim()) ||
      (email ? String(email).split("@")[0] : "Unknown");

    if (!snap.exists) {
      await ref.set({ name: displayName, email: email || null, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      return res.status(201).json({ ok: true, created: true });
    }
    await ref.update({ name: displayName, email: email || null, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return res.status(200).json({ ok: true, created: false });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// -------------------- EVENTS --------------------

app.get("/events", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    const snapshot = await db.collection(EVENTS).orderBy("createdAt", "desc").limit(limit).get();
    const events = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json({ count: events.length, events, limit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/events/mine", requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    const snapshot = await db.collection(EVENTS).where("ownerUid", "==", uid).orderBy("createdAt", "desc").limit(limit).get();
    const events = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json({ count: events.length, events, limit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/events/registered", requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;

    const regSnap = await db.collection(REGISTRATIONS).where("uid", "==", uid).get();
    const eventIds = regSnap.docs.map((doc) => doc.data().eventId).filter(Boolean);

    if (eventIds.length === 0) {
      return res.status(200).json({ count: 0, events: [] });
    }

    const chunks = [];
    for (let i = 0; i < eventIds.length; i += 30) {
      chunks.push(eventIds.slice(i, i + 30));
    }

    const events = [];
    await Promise.all(
      chunks.map(async (chunk) => {
        const snap = await db.collection(EVENTS).where(admin.firestore.FieldPath.documentId(), "in", chunk).get();
        snap.docs.forEach((doc) => events.push({ id: doc.id, ...doc.data() }));
      })
    );

    res.status(200).json({ count: events.length, events });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/events/registration-counts", async (req, res) => {
  try {
    const regSnap = await db.collection(REGISTRATIONS).get();
    const counts = {};
    regSnap.docs.forEach((doc) => {
      const { eventId } = doc.data();
      if (eventId) counts[eventId] = (counts[eventId] || 0) + 1;
    });
    res.status(200).json({ counts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -------------------- REGISTRATIONS --------------------

app.post("/events/:id/register", requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { id } = req.params;

    const eventDoc = await db.collection(EVENTS).doc(id).get();
    if (!eventDoc.exists) return res.status(404).json({ error: "Esemény nem található" });

    const userDoc = await db.collection(USERS).doc(uid).get();
    const userData = userDoc.exists ? userDoc.data() : null;

    const regId = `${uid}_${id}`;
    await db.collection(REGISTRATIONS).doc(regId).set({
      uid,
      eventId: id,
      eventTitle: eventDoc.data().title || null,
      userName: userData?.name || req.user?.email?.split("@")[0] || "Unknown",
      userEmail: userData?.email || req.user?.email || null,
      registeredAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({ ok: true, msg: "Sikeres jelentkezés" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/events/:id/register", requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { id } = req.params;

    const regId = `${uid}_${id}`;
    await db.collection(REGISTRATIONS).doc(regId).delete();

    res.status(200).json({ ok: true, msg: "Sikeres leiratkozás" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/events/:id/registrations", async (req, res) => {
  try {
    const { id } = req.params;
    const snap = await db.collection(REGISTRATIONS).where("eventId", "==", id).get();
    const registrations = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json({ count: registrations.length, registrations });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -------------------- EVENTS CRUD --------------------

app.get("/events/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await db.collection(EVENTS).doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: "A megadott esemény nem létezik" });
    res.status(200).json({ id: doc.id, ...doc.data() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/events", requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { title, location, description, imageUrl, imageDeleteUrl, images, date, time } = req.body;

    if (!isNonEmptyString(title)) return res.status(400).json({ error: "title is required" });
    if (date !== undefined && date !== null && !dateRegex.test(date)) {
      return res.status(400).json({ error: "date format must be yyyy.mm.dd" });
    }
    if (time !== undefined && time !== null && !timeRegex.test(time)) {
      return res.status(400).json({ error: "time format must be hh:mm (e.g. 16:30)" });
    }

    const userDoc = await db.collection(USERS).doc(uid).get();
    const userData = userDoc.exists ? userDoc.data() : null;
    const ownerName =
      (userData?.name && String(userData.name).trim()) ||
      (req.user?.name && String(req.user.name).trim()) ||
      (req.user?.email ? String(req.user.email).split("@")[0] : "Unknown");
    const ownerEmail = userData?.email || req.user?.email || null;
    const imagesData = Array.isArray(images) && images.length > 0 ? images : [];

    const validDate = isValidDate(date) ? date : null;
    const validTime = isValidTime(time) ? time : null;

    const docRef = await db.collection(EVENTS).add({
      title: title.trim(),
      location: isNonEmptyString(location) ? location.trim() : null,
      description: isNonEmptyString(description) ? description.trim() : null,
      imageUrl: isNonEmptyString(imageUrl) ? imageUrl.trim() : (imagesData[0]?.url || null),
      imageDeleteUrl: isNonEmptyString(imageDeleteUrl) ? imageDeleteUrl.trim() : (imagesData[0]?.delete_url || null),
      images: imagesData,
      date: validDate,
      time: validTime,
      // Kényelmi mező a frontendnek: "2026.04.13 16:30" vagy csak "2026.04.13" ha nincs idő
      datetime: validDate ? (validTime ? `${validDate} ${validTime}` : validDate) : null,
      ownerUid: uid,
      ownerName,
      ownerEmail,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/events/:id", requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { id } = req.params;
    const { title, location, description, images, imageUrl, imageDeleteUrl, date, time } = req.body;

    if (!isNonEmptyString(title)) return res.status(400).json({ error: "Hibás kérés: title kötelező" });
    if (date !== undefined && date !== null && !dateRegex.test(date)) {
      return res.status(400).json({ error: "date format must be yyyy.mm.dd" });
    }
    if (time !== undefined && time !== null && !timeRegex.test(time)) {
      return res.status(400).json({ error: "time format must be hh:mm (e.g. 16:30)" });
    }

    const ref = db.collection(EVENTS).doc(id);
    const docSnap = await ref.get();
    if (!docSnap.exists) return res.status(404).json({ error: "A megadott esemény nem létezik" });
    if (docSnap.data().ownerUid !== uid) return res.status(403).json({ error: "Nem a te eseményed" });

    const imagesData = Array.isArray(images) ? images : [];
    const validDate = isValidDate(date) ? date : null;
    const validTime = isValidTime(time) ? time : null;

    await ref.update({
      title: title.trim(),
      location: isNonEmptyString(location) ? location.trim() : null,
      description: isNonEmptyString(description) ? description.trim() : null,
      imageUrl: isNonEmptyString(imageUrl) ? imageUrl.trim() : (imagesData[0]?.url || null),
      imageDeleteUrl: isNonEmptyString(imageDeleteUrl) ? imageDeleteUrl.trim() : (imagesData[0]?.delete_url || null),
      images: imagesData,
      date: validDate,
      time: validTime,
      // Kényelmi mező a frontendnek: "2026.04.13 16:30" vagy csak "2026.04.13" ha nincs idő
      datetime: validDate ? (validTime ? `${validDate} ${validTime}` : validDate) : null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({ ok: true, msg: "Sikeres módosítás" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/events/:id", requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { id } = req.params;

    const ref = db.collection(EVENTS).doc(id);
    const docSnap = await ref.get();
    if (!docSnap.exists) return res.status(404).json({ error: "A megadott esemény nem létezik" });
    if (docSnap.data().ownerUid !== uid) return res.status(403).json({ error: "Nem a te eseményed" });

    const regSnap = await db.collection(REGISTRATIONS).where("eventId", "==", id).get();
    const batch = db.batch();
    regSnap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    await ref.delete();
    res.status(200).json({ ok: true, msg: "Sikeres törlés" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ── Segédfüggvény: csak admin mehet tovább ────────────────────────────────────
async function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    req.user = await auth.verifyIdToken(token);
    const userDoc = await db.collection(USERS).doc(req.user.uid).get();
    if (!userDoc.exists || !userDoc.data().isAdmin) {
      return res.status(403).json({ error: "Admin jogosultság szükséges" });
    }
    return next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token", details: e.message });
  }
}

// ── GET /admin/stats ──────────────────────────────────────────────────────────
app.get("/admin/stats", requireAdmin, async (req, res) => {
  try {
    const [usersSnap, eventsSnap, regsSnap] = await Promise.all([
      db.collection(USERS).get(),
      db.collection(EVENTS).orderBy("createdAt", "desc").limit(10).get(),
      db.collection(REGISTRATIONS).get(),
    ]);

    const recentEvents = eventsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    res.status(200).json({
      totalUsers: usersSnap.size,
      totalEvents: (await db.collection(EVENTS).get()).size,
      totalRegistrations: regsSnap.size,
      recentEvents,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /admin/users ──────────────────────────────────────────────────────────
app.get("/admin/users", requireAdmin, async (req, res) => {
  try {
    const snap = await db.collection(USERS).orderBy("name").get();
    const users = snap.docs.map((doc) => ({ uid: doc.id, ...doc.data() }));
    res.status(200).json({ count: users.length, users });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /admin/users/:uid ─────────────────────────────────────────────────────
// Body: { name?, isAdmin? }
app.put("/admin/users/:uid", requireAdmin, async (req, res) => {
  try {
    const { uid } = req.params;
    const { name, isAdmin } = req.body;

    const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (isNonEmptyString(name)) {
      updates.name = name.trim();
      await auth.updateUser(uid, { displayName: name.trim() });
    }
    if (typeof isAdmin === "boolean") {
      updates.isAdmin = isAdmin;
    }

    await db.collection(USERS).doc(uid).update(updates);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /admin/users/:uid ──────────────────────────────────────────────────
// Törli a usert + összes eseményét (képekkel) + regisztrációit
app.delete("/admin/users/:uid", requireAdmin, async (req, res) => {
  try {
    const { uid } = req.params;

    // 1. Saját események lekérése
    const eventsSnap = await db.collection(EVENTS).where("ownerUid", "==", uid).get();

    // 2. Minden esemény regisztrációinak törlése + az esemény törlése
    await Promise.all(
      eventsSnap.docs.map(async (evDoc) => {
        const eventId = evDoc.id;
        // regisztrációk törlése
        const regSnap = await db.collection(REGISTRATIONS).where("eventId", "==", eventId).get();
        const batch = db.batch();
        regSnap.docs.forEach((r) => batch.delete(r.ref));
        batch.delete(evDoc.ref);
        await batch.commit();
      })
    );

    // 3. A userhez tartozó regisztrációk törlése (más eseményekre)
    const userRegsSnap = await db.collection(REGISTRATIONS).where("uid", "==", uid).get();
    if (!userRegsSnap.empty) {
      const batch = db.batch();
      userRegsSnap.docs.forEach((r) => batch.delete(r.ref));
      await batch.commit();
    }

    // 4. Firestore user doc törlése
    await db.collection(USERS).doc(uid).delete();

    // 5. Firebase Auth fiók törlése
    try {
      await auth.deleteUser(uid);
    } catch (authErr) {
      // Ha már nem létezik az auth-ban, nem baj
      console.warn("Auth delete warning:", authErr.message);
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /admin/events/:id ──────────────────────────────────────────────────
// Adminként bármilyen esemény törlése (és a hozzá tartozó regisztrációké)
app.delete("/admin/events/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const eventRef = db.collection(EVENTS).doc(id);
    const eventSnap = await eventRef.get();

    // 1. Ellenőrizzük, létezik-e az esemény
    if (!eventSnap.exists) {
      return res.status(404).json({ error: "A megadott esemény nem létezik" });
    }

    // 2. Kapcsolódó regisztrációk törlése batch-ben
    const regSnap = await db.collection(REGISTRATIONS).where("eventId", "==", id).get();
    const batch = db.batch();
    
    regSnap.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });

    // 3. Magának az eseménynek a törlése (hozzáadjuk a batch-hez)
    batch.delete(eventRef);

    // 4. Tranzakció végrehajtása
    await batch.commit();

    res.status(200).json({ 
      ok: true, 
      msg: "Esemény és kapcsolódó regisztrációk sikeresen törölve (admin által)" 
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /admin/events/:id ─────────────────────────────────────────────────────
// Adminként bármilyen esemény módosítása
app.put("/admin/events/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      title, 
      location, 
      description, 
      images, 
      imageUrl, 
      imageDeleteUrl, 
      date, 
      time 
    } = req.body;

    // 1. Alapvető validáció (Adminnál is kötelező a cím)
    if (!isNonEmptyString(title)) {
      return res.status(400).json({ error: "Hibás kérés: title kötelező" });
    }

    // 2. Formátum ellenőrzések (Regex)
    if (date && !dateRegex.test(date)) {
      return res.status(400).json({ error: "Hibás dátum formátum: yyyy.mm.dd szükséges" });
    }
    if (time && !timeRegex.test(time)) {
      return res.status(400).json({ error: "Hibás idő formátum: hh:mm szükséges" });
    }

    const eventRef = db.collection(EVENTS).doc(id);
    const docSnap = await eventRef.get();

    // 3. Létezés ellenőrzése
    if (!docSnap.exists) {
      return res.status(404).json({ error: "A megadott esemény nem létezik" });
    }

    // Előkészítjük az adatokat
    const imagesData = Array.isArray(images) ? images : [];
    const validDate = isValidDate(date) ? date : null;
    const validTime = isValidTime(time) ? time : null;

    // 4. Módosítás végrehajtása
    // (Itt nincs ownerUid ellenőrzés, mert a requireAdmin már lefutott)
    await eventRef.update({
      title: title.trim(),
      location: isNonEmptyString(location) ? location.trim() : null,
      description: isNonEmptyString(description) ? description.trim() : null,
      imageUrl: isNonEmptyString(imageUrl) ? imageUrl.trim() : (imagesData[0]?.url || null),
      imageDeleteUrl: isNonEmptyString(imageDeleteUrl) ? imageDeleteUrl.trim() : (imagesData[0]?.delete_url || null),
      images: imagesData,
      date: validDate,
      time: validTime,
      datetime: validDate ? (validTime ? `${validDate} ${validTime}` : validDate) : null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      adminLastEdit: req.user.uid // Opcionális: nyomon követhető, melyik admin módosította utoljára
    });

    res.status(200).json({ 
      ok: true, 
      msg: "Esemény sikeresen módosítva az adminisztrátor által" 
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

//feltöltés végpont:
app.post('/api/uploadProfile', requireAuth, async (req, resp) => {
    try {
        const { image } = req.body; // A Profile.jsx-ből base64 érkezik
        if (!image) return resp.status(400).json({ error: "Nincs kép!" });

        const uploadResponse = await cloudinary.uploader.upload(image, {
            folder: "profile_pics"
        });

        resp.json({
            url: uploadResponse.secure_url,
            public_id: uploadResponse.public_id
        });
    } catch (error) {
        console.error(error);
        resp.status(500).json({ error: "Cloudinary feltöltési hiba!" });
    }
});


//törlés végpont:
app.post('/api/deleteImage', async (req, resp)=>{
    try {
        const {public_id} = req.body
        console.log("public_id kliensoldalról: " + public_id)
        const deleteResult = await cloudinary.uploader.destroy(public_id)
        if(deleteResult.result=="ok") resp.json({serverMsg:"Image deleted successfully!"})
        else resp.status(404).json({serverMsg:"Image not found or already deleted!"})
    } catch (error) {
        console.log(error)
        resp.status(500).json({serverMsg:"Failed to delete image!"})
    }

})

if (process.env.NODE_ENV !== "production") {
  app.listen(port, () => console.log("Server is listening on port: " + port));
}

export default app;