import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import fs from "node:fs";

const serviceAccount = JSON.parse(
  fs.readFileSync(new URL("./serviceAccountKey.json", import.meta.url), "utf8")
);

const app = express();
app.use(cors());
app.use(express.json());

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const auth = admin.auth();

const port = 8000;

const USERS_COLLECTION = "users";
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


//összes user lekérése
app.get("/users", async (req, res) => {
  try {
    const snapshot = await db.collection(USERS_COLLECTION).get();
    const users = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ count: users.length, users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

//új user hozzáadáasa
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

    await db.collection(USERS_COLLECTION).doc(userRecord.uid).set({
      name: name.trim(),
      email: email.trim(),
    });

    res.status(201).json({ ok: true, uid: userRecord.uid });
  } catch (e) {
    if (e?.code === "auth/email-already-exists") {
      return res.status(409).json({ error: "Email already exists" });
    }
    if (e?.code === "auth/invalid-password") {
      return res.status(400).json({ error: "Invalid password" });
    }
    res.status(500).json({ error: e.message });
  }
});

//felhasználó szerkesztése még kell

//esemény létrehozás
app.post("/events", requireAuth, async (req, res) => {
 
});
//események listázása
app.get("/events", async (req, res) => {
  
});


//saját esemény törlés
app.delete("/events/:id", requireAuth, async (req, res) => {
  
});

app.listen(port, () => console.log("Server is listening on port: " + port));