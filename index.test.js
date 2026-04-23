import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
 
// --- Cloudinary mock ---
vi.mock("cloudinary", () => ({
  v2: {
    uploader: {
      upload: vi.fn(),
      destroy: vi.fn(),
    },
  },
}));
 
// --- requireAuth mock: mindig átengedi ---
const requireAuth = (req, res, next) => next();
 
import { v2 as cloudinary } from "cloudinary";
 
// --- App felépítése (ugyanúgy mint az eredetiben) ---
const buildApp = () => {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
 
  app.post("/api/uploadProfile", requireAuth, async (req, resp) => {
    try {
      const { image } = req.body;
      if (!image) return resp.status(400).json({ error: "Nincs kép!" });
 
      const uploadResponse = await cloudinary.uploader.upload(image, {
        folder: "profile_pics",
      });
 
      resp.json({
        url: uploadResponse.secure_url,
        public_id: uploadResponse.public_id,
      });
    } catch (error) {
      resp.status(500).json({ error: "Cloudinary feltöltési hiba!" });
    }
  });
 
  app.post("/api/deleteImage", async (req, resp) => {
    try {
      const { public_id } = req.body;
      const deleteResult = await cloudinary.uploader.destroy(public_id);
 
      if (deleteResult.result === "ok")
        resp.json({ serverMsg: "Image deleted successfully!" });
      else
        resp.status(404).json({ serverMsg: "Image not found or already deleted!" });
    } catch (error) {
      resp.status(500).json({ serverMsg: "Failed to delete image!" });
    }
  });
 
  return app;
};
 
const app = buildApp();
 
// ---------------------------
// POST /api/uploadProfile
// ---------------------------
describe("POST /api/uploadProfile", () => {
  beforeEach(() => vi.clearAllMocks());
 
  it("400-at ad vissza ha nincs image a body-ban", async () => {
    const res = await request(app)
      .post("/api/uploadProfile")
      .send({});
 
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Nincs kép!");
  });
 
  it("sikeres feltöltéskor visszaadja az url-t és a public_id-t", async () => {
    cloudinary.uploader.upload.mockResolvedValue({
      secure_url: "https://cloudinary.com/img/abc.jpg",
      public_id: "profile_pics/abc",
    });
 
    const res = await request(app)
      .post("/api/uploadProfile")
      .send({ image: "data:image/jpeg;base64,/9j/testbase64" });
 
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      url: "https://cloudinary.com/img/abc.jpg",
      public_id: "profile_pics/abc",
    });
    expect(cloudinary.uploader.upload).toHaveBeenCalledWith(
      "data:image/jpeg;base64,/9j/testbase64",
      { folder: "profile_pics" }
    );
  });
 
  it("500-at ad vissza ha a Cloudinary hibát dob", async () => {
    cloudinary.uploader.upload.mockRejectedValue(new Error("Cloudinary down"));
 
    const res = await request(app)
      .post("/api/uploadProfile")
      .send({ image: "data:image/jpeg;base64,/9j/testbase64" });
 
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Cloudinary feltöltési hiba!");
  });
});
 
// ---------------------------
// POST /api/deleteImage
// ---------------------------
describe("POST /api/deleteImage", () => {
  beforeEach(() => vi.clearAllMocks());
 
  it("sikeresen törli a képet és visszaad egy üzenetet", async () => {
    cloudinary.uploader.destroy.mockResolvedValue({ result: "ok" });
 
    const res = await request(app)
      .post("/api/deleteImage")
      .send({ public_id: "profile_pics/abc" });
 
    expect(res.status).toBe(200);
    expect(res.body.serverMsg).toBe("Image deleted successfully!");
    expect(cloudinary.uploader.destroy).toHaveBeenCalledWith("profile_pics/abc");
  });
 
  it("404-et ad vissza ha a kép nem található", async () => {
    cloudinary.uploader.destroy.mockResolvedValue({ result: "not found" });
 
    const res = await request(app)
      .post("/api/deleteImage")
      .send({ public_id: "profile_pics/nem_letezik" });
 
    expect(res.status).toBe(404);
    expect(res.body.serverMsg).toBe("Image not found or already deleted!");
  });
 
  it("500-at ad vissza ha a Cloudinary hibát dob", async () => {
    cloudinary.uploader.destroy.mockRejectedValue(new Error("Cloudinary down"));
 
    const res = await request(app)
      .post("/api/deleteImage")
      .send({ public_id: "profile_pics/abc" });
 
    expect(res.status).toBe(500);
    expect(res.body.serverMsg).toBe("Failed to delete image!");
  });
 
  it("kezeli ha nincs public_id a body-ban (undefined-dal hívja a Cloudinary-t)", async () => {
    cloudinary.uploader.destroy.mockResolvedValue({ result: "not found" });
 
    const res = await request(app)
      .post("/api/deleteImage")
      .send({});
 
    expect(cloudinary.uploader.destroy).toHaveBeenCalledWith(undefined);
    expect(res.status).toBe(404);
  });
});