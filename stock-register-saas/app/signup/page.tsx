import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import AuthPage from "@/components/AuthPage";

export const metadata = { title: "Sign up — GodownBook" };

export default async function SignupPage() {
  if (await currentUser()) redirect("/app");
  return <AuthPage mode="signup" />;
}
