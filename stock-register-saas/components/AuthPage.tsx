import Logo from "./Logo";
import AuthForm from "./AuthForm";

export default function AuthPage({ mode }: { mode: "login" | "signup" }) {
  const signup = mode === "signup";
  return (
    <div className="bg-dots flex min-h-full items-center justify-center px-4 py-10">
      <div className="card-3d pop-in w-full max-w-sm p-6">
        <div className="mb-6">
          <Logo />
        </div>
        <h1 className="mb-1 text-2xl font-bold tracking-tight">{signup ? "Open your GodownBook" : "Welcome back"}</h1>
        <p className="mb-5 text-sm text-ink/70">
          {signup ? "Every Pro feature free for 90 days. No card needed." : "Log in to your book. Staff can log in here too."}
        </p>
        <AuthForm mode={mode} />
      </div>
    </div>
  );
}
