"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiStore } from "@/lib/store";
import Avatar from "./Avatar";
import Logo from "./Logo";
import ProfileModal from "./ProfileModal";
import Workspace from "./Workspace";

export default function AppShell({
  name,
  email,
  roleLabel,
  avatar: initialAvatar,
}: {
  /** Shown in the header (staff see "Name · Business"). */
  name: string;
  email: string;
  roleLabel: string;
  avatar: string | null;
}) {
  const router = useRouter();
  const [avatar, setAvatar] = useState(initialAvatar);
  const [profileOpen, setProfileOpen] = useState(false);
  const personName = name.split(" · ")[0];

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/");
    router.refresh();
  }

  return (
    <div className="flex min-h-full flex-col bg-surface">
      <header className="sticky top-0 z-40 flex items-center justify-between bg-gradient-to-b from-[#18211b] to-ink px-3 py-3 text-paper shadow-[0_8px_20px_-10px_rgb(0_0_0/0.6)] sm:px-4 print:hidden">
        <Logo href="/app" />
        <div className="flex items-center gap-2 text-sm sm:gap-3">
          <button
            onClick={() => setProfileOpen(true)}
            className="flex items-center gap-2 rounded-full py-0.5 pl-0.5 pr-0.5 text-paper/85 hover:bg-paper/10 focus-visible:outline-2 focus-visible:outline-brand sm:pr-3"
            aria-label="My profile"
            title="My profile"
          >
            <Avatar name={personName} src={avatar} size={32} />
            <span className="hidden max-w-[16rem] truncate sm:inline">{name}</span>
          </button>
          <button onClick={logout} className="rounded-lg border border-paper/25 bg-paper/5 px-2.5 py-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.12)] hover:bg-paper/15">
            Log out
          </button>
        </div>
      </header>
      <div className="mx-auto w-full max-w-7xl flex-1">
        <Workspace store={apiStore} />
      </div>
      {profileOpen && (
        <ProfileModal
          name={personName}
          email={email}
          roleLabel={roleLabel}
          avatar={avatar}
          onClose={() => setProfileOpen(false)}
          onSaved={(a) => {
            setAvatar(a);
            setProfileOpen(false);
          }}
        />
      )}
    </div>
  );
}
