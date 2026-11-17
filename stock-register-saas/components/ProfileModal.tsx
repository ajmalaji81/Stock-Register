"use client";

import { useRef, useState } from "react";
import { AVATAR_SIZE, avatarError } from "@/lib/avatar";
import Avatar from "./Avatar";
import { Button, Modal } from "./ui";

/** Crop the centre square of an image file and shrink it to AVATAR_SIZE, as a JPEG data URL. */
async function toAvatarDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Please choose an image file (JPG, PNG or WebP).");
  if (file.size > 15 * 1024 * 1024) throw new Error("That image is over 15 MB. Please choose a smaller one.");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Couldn't read that image. Try a JPG or PNG."));
      el.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - side) / 2;
    const sy = (img.naturalHeight - side) / 2;
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Your browser can't process images here.");
    ctx.fillStyle = "#ffffff"; // transparent PNGs get a white background in JPEG
    ctx.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function ProfileModal({
  name,
  email,
  roleLabel,
  avatar,
  onClose,
  onSaved,
}: {
  name: string;
  email: string;
  roleLabel: string;
  avatar: string | null;
  onClose: () => void;
  onSaved: (avatar: string | null) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(avatar);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = preview !== avatar;

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const url = await toAvatarDataUrl(file);
      const err = avatarError(url);
      if (err) throw new Error(err);
      setPreview(url);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatar: preview }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Couldn't save your picture");
      onSaved(preview);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="My profile" onClose={onClose}>
      <div className="flex flex-col items-center gap-3 text-center">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="group relative rounded-full focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-ink"
          aria-label="Choose a profile picture"
        >
          <Avatar name={name} src={preview} size={112} />
          <span className="absolute inset-0 grid place-items-center rounded-full bg-ink/55 text-xs font-bold text-paper opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
            Change
          </span>
        </button>
        <div>
          <div className="text-lg font-bold">{name}</div>
          <div className="text-sm text-ink/60">{email}</div>
          <div className="mt-1 text-xs font-semibold uppercase tracking-wide text-ink/50">{roleLabel}</div>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="ghost" onClick={() => fileRef.current?.click()}>📷 {preview ? "Change picture" : "Upload picture"}</Button>
          {preview && (
            <Button variant="danger" onClick={() => setPreview(null)}>Remove</Button>
          )}
        </div>
        <p className="text-xs text-ink/60">JPG, PNG or WebP. We crop it to a square and shrink it, so any phone photo works.</p>
        {error && (
          <p role="alert" className="w-full rounded-lg border-2 border-out bg-out/10 px-3 py-2 text-sm font-medium text-out">{error}</p>
        )}
        <Button onClick={save} disabled={!changed || busy} className="w-full py-3">
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </Modal>
  );
}
