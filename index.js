import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import fs from "node:fs";
import dotenv from "dotenv";
import multer from "multer";
import axios from "axios";

dotenv.config();

let serviceAccount;
if (process.env.SERVICE_ACCOUNT_KEY) {
  const rawKey = process.env.SERVICE_ACCOUNT_KEY;
  // Kicseréljük a szöveges \n karaktereket valódi sortörésre
  serviceAccount = JSON.parse(rawKey);
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
}
else {
  serviceAccount = JSON.parse(
    fs.readFileSync(new URL("./serviceAccountKey.json", import.meta.url), "utf8")
  );
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const auth = admin.auth();

const app = express();

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

function isNonEmptyString(x) {
  return typeof x === "string" && x.trim().length > 0;
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
    const { name } = req.body;
    if (!isNonEmptyString(name)) return res.status(400).json({ error: "name is required" });
    await db.collection(USERS).doc(uid).update({ name: name.trim(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    await auth.updateUser(uid, { displayName: name.trim() });
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
    const { title, location, description, imageUrl, imageDeleteUrl, images } = req.body;
    if (!isNonEmptyString(title)) return res.status(400).json({ error: "title is required" });

    const userDoc = await db.collection(USERS).doc(uid).get();
    const userData = userDoc.exists ? userDoc.data() : null;
    const ownerName =
      (userData?.name && String(userData.name).trim()) ||
      (req.user?.name && String(req.user.name).trim()) ||
      (req.user?.email ? String(req.user.email).split("@")[0] : "Unknown");
    const ownerEmail = userData?.email || req.user?.email || null;
    const imagesData = Array.isArray(images) && images.length > 0 ? images : [];

    const docRef = await db.collection(EVENTS).add({
      title: title.trim(),
      location: isNonEmptyString(location) ? location.trim() : null,
      description: isNonEmptyString(description) ? description.trim() : null,
      imageUrl: isNonEmptyString(imageUrl) ? imageUrl.trim() : (imagesData[0]?.url || null),
      imageDeleteUrl: isNonEmptyString(imageDeleteUrl) ? imageDeleteUrl.trim() : (imagesData[0]?.delete_url || null),
      images: imagesData,
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
    const { title, location, description, images, imageUrl, imageDeleteUrl } = req.body;
    if (!isNonEmptyString(title)) return res.status(400).json({ error: "Hibás kérés: title kötelező" });

    const ref = db.collection(EVENTS).doc(id);
    const docSnap = await ref.get();
    if (!docSnap.exists) return res.status(404).json({ error: "A megadott esemény nem létezik" });
    if (docSnap.data().ownerUid !== uid) return res.status(403).json({ error: "Nem a te eseményed" });

    const imagesData = Array.isArray(images) ? images : [];
    await ref.update({
      title: title.trim(),
      location: isNonEmptyString(location) ? location.trim() : null,
      description: isNonEmptyString(description) ? description.trim() : null,
      imageUrl: isNonEmptyString(imageUrl) ? imageUrl.trim() : (imagesData[0]?.url || null),
      imageDeleteUrl: isNonEmptyString(imageDeleteUrl) ? imageDeleteUrl.trim() : (imagesData[0]?.delete_url || null),
      images: imagesData,
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

if (process.env.NODE_ENV !== "production") {
  app.listen(port, () => console.log("Server is listening on port: " + port));
}

export default app;