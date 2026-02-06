import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import fs from "node:fs";

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

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing Authorization Bearer token" });
  }

  try {
    req.user = await auth.verifyIdToken(token)
    return next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token", details: e.message });
  }
}

// összes user (admin jellegű – ha nem akarod nyitva, tedd requireAuth-ra)
app.get("/users", async (req, res) => {
  try {
    const snapshot = await db.collection(USERS).orderBy("name").get();
    const users = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json({ count: users.length, users });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// új user regisztráció (Auth user létrehozás + Firestore profil)
app.post("/users/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required (non-empty string)" });
    }
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ error: "valid email is required" });
    }
    if (!password || typeof password !== "string" || password.length < 6) {
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

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required (non-empty string)" });
    }

    await db.collection(USERS).doc(uid).update({
      name: name.trim(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // opcionális: Auth displayName is frissül
    await auth.updateUser(uid, { displayName: name.trim() });

    res.status(200).json({ ok: true, msg: "Sikeres módosítás" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



// összes esemény listázása (ha publikusnak akarod, maradhat nyitva)
app.get("/events", async (req, res) => {
  try {
    const snapshot = await db
      .collection(EVENTS)
      .orderBy("createdAt", "desc")
      .get();

    const events = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json({ count: events.length, events });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// saját események (mint a MySQL-ben: "egy adott kategória" analóg – itt owner szerint)
app.get("/events/mine", requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;

    const snapshot = await db
      .collection(EVENTS)
      .where("ownerUid", "==", uid)
      .orderBy("createdAt", "desc")
      .get();

    const events = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json({ count: events.length, events });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// esemény létrehozás
app.post("/events", requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { title, location } = req.body;

    if (!title || typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "title is required" });
    }

    const docRef = await db.collection(EVENTS).add({
      title: title.trim(),
      location: typeof location === "string" && location.trim() ? location.trim() : null,
      ownerUid: uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// esemény törlés (csak saját)
app.delete("/events/:id", requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { id } = req.params;

    const ref = db.collection(EVENTS).doc(id);
    const doc = await ref.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "A megadott esemény nem létezik" });
    }
    if (doc.data().ownerUid !== uid) {
      return res.status(403).json({ error: "Nem a te eseményed" });
    }

    await ref.delete();
    res.status(200).json({ msg: "Sikeres törlés" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// esemény módosítás (csak saját)
app.put("/events/:id", requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { id } = req.params;
    const { title, location } = req.body;

    if (!title || typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "Hibás kérés: title kötelező" });
    }

    const ref = db.collection(EVENTS).doc(id);
    const doc = await ref.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "A megadott esemény nem létezik" });
    }
    if (doc.data().ownerUid !== uid) {
      return res.status(403).json({ error: "Nem a te eseményed" });
    }

    await ref.update({
      title: title.trim(),
      location: typeof location === "string" && location.trim() ? location.trim() : null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({ msg: "Sikeres módosítás" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.listen(port, () => console.log("Server is listening on port: " + port));
