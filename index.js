import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import fs from "node:fs";
import dotenv from "dotenv";
import multer from "multer";
import axios from "axios";

// ---- .env ----
dotenv.config();

// ---- Firebase Admin init (service account) ----
const serviceAccount = JSON.parse(
  fs.readFileSync(new URL("./serviceAccountKey.json", import.meta.url), "utf8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const auth = admin.auth();

const app = express();
app.use(cors());
app.use(express.json());

const port = 8000;
const USERS = "users";
const EVENTS = "events";

// ---- Multer (memory) for multipart upload ----
const upload = multer({ storage: multer.memoryStorage() });

// --- helper: basic validation ---
function isNonEmptyString(x) {
  return typeof x === "string" && x.trim().length > 0;
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing Authorization Bearer token" });
  }

  try {
    req.user = await auth.verifyIdToken(token);
    return next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token", details: e.message });
  }
}

// -------------------- IMAGE (imgbb via backend) --------------------
// POST /api/uploadImage  (multipart/form-data, field: image)
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

    // imgbb: delete_url egy direkt link, azt elmentheted
    res.status(200).json({
      url: data.url,
      delete_url: data.delete_url || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/deleteImage  { delete_url }
app.post("/api/deleteImage", requireAuth, async (req, res) => {
  try {
    const { delete_url } = req.body;
    if (!isNonEmptyString(delete_url)) {
      return res.status(400).json({ error: "delete_url is required" });
    }

    // imgbb delete_url: általában elég GET
    await axios.get(delete_url.trim());

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -------------------- USERS --------------------

// összes user (ha nem akarod nyitva, tedd requireAuth-ra)
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

// saját profil lekérése (tokenből)
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

// új user regisztráció (Auth user + Firestore profil)
app.post("/users/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!isNonEmptyString(name)) {
      return res.status(400).json({ error: "name is required (non-empty string)" });
    }
    if (!isNonEmptyString(email) || !email.includes("@")) {
      return res.status(400).json({ error: "valid email is required" });
    }
    if (!isNonEmptyString(password) || password.length < 6) {
      return res.status(400).json({ error: "password must be at least 6 characters" });
    }

    const userRecord = await auth.createUser({
      email: email.trim(),
      password,
      displayName: name.trim(),
    });

    await db.collection(USERS).doc(userRecord.uid).set({
      name: name.trim(),
      email: email.trim(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(201).json({ ok: true, uid: userRecord.uid });
  } catch (e) {
    if (e?.code === "auth/email-already-exists") {
      return res.status(409).json({ error: "Email already exists" });
    }
    res.status(500).json({ error: e.message });
  }
});

// felhasználó frissítése (csak saját magát)
app.put("/users/me", requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { name } = req.body;

    if (!isNonEmptyString(name)) {
      return res.status(400).json({ error: "name is required (non-empty string)" });
    }

    await db.collection(USERS).doc(uid).update({
      name: name.trim(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await auth.updateUser(uid, { displayName: name.trim() });

    res.status(200).json({ ok: true, msg: "Sikeres módosítás" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -------------------- EVENTS --------------------

// összes esemény listázása (publikus)
app.get("/events", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);

    const snapshot = await db
      .collection(EVENTS)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    const events = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json({ count: events.length, events, limit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// saját események (owner szerint)
app.get("/events/mine", requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);

    const snapshot = await db
      .collection(EVENTS)
      .where("ownerUid", "==", uid)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    const events = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json({ count: events.length, events, limit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 1 esemény lekérése id alapján
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

// esemény létrehozás
app.post("/events", requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { title, location, description, imageUrl, imageDeleteUrl } = req.body;

    if (!isNonEmptyString(title)) {
      return res.status(400).json({ error: "title is required" });
    }

    const userDoc = await db.collection(USERS).doc(uid).get();
    const userData = userDoc.exists ? userDoc.data() : null;

    const ownerName =
      (userData?.name && String(userData.name).trim()) ||
      (req.user?.name && String(req.user.name).trim()) ||
      (req.user?.email ? String(req.user.email).split("@")[0] : "Unknown");

    const ownerEmail = userData?.email || req.user?.email || null;

    const docRef = await db.collection(EVENTS).add({
      title: title.trim(),
      location: isNonEmptyString(location) ? location.trim() : null,
      description: isNonEmptyString(description) ? description.trim() : null, // ✅

      imageUrl: isNonEmptyString(imageUrl) ? imageUrl.trim() : null,
      imageDeleteUrl: isNonEmptyString(imageDeleteUrl) ? imageDeleteUrl.trim() : null,

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

// esemény módosítás (csak saját) – itt már kép is mehet
app.put("/events/:id", requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { id } = req.params;
    const { title, location, imageUrl, imageDeleteUrl } = req.body;

    if (!isNonEmptyString(title)) {
      return res.status(400).json({ error: "Hibás kérés: title kötelező" });
    }

    const ref = db.collection(EVENTS).doc(id);
    const docSnap = await ref.get();

    if (!docSnap.exists) return res.status(404).json({ error: "A megadott esemény nem létezik" });
    if (docSnap.data().ownerUid !== uid) return res.status(403).json({ error: "Nem a te eseményed" });

    await ref.update({
      title: title.trim(),
      location: isNonEmptyString(location) ? location.trim() : null,

      imageUrl: isNonEmptyString(imageUrl) ? imageUrl.trim() : null,
      imageDeleteUrl: isNonEmptyString(imageDeleteUrl) ? imageDeleteUrl.trim() : null,

      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({ ok: true, msg: "Sikeres módosítás" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// esemény törlés (csak saját) – képet a frontend törli előtte (utils.js)
app.delete("/events/:id", requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { id } = req.params;

    const ref = db.collection(EVENTS).doc(id);
    const docSnap = await ref.get();

    if (!docSnap.exists) return res.status(404).json({ error: "A megadott esemény nem létezik" });
    if (docSnap.data().ownerUid !== uid) return res.status(403).json({ error: "Nem a te eseményed" });

    await ref.delete();
    res.status(200).json({ ok: true, msg: "Sikeres törlés" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(port, () => console.log("Server is listening on port: " + port));
