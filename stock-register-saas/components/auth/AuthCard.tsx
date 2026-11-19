import type { ReactNode } from "react";
import Logo from "../Logo";

/** The raised card used by every logged-out page (login, sign-up, forgot / reset password). */
export default function AuthCard({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="bg-dots flex min-h-full items-center justify-center px-4 py-10">
      <div className="card-3d pop-in w-full max-w-sm p-6">
        <div className="mb-6">
          <Logo />
        </div>
        <h1 className="mb-1 text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mb-5 text-sm text-ink/70">{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}
