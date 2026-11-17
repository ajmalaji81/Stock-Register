import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import AuthPage from "@/components/AuthPage";

export const metadata = { title: "Log in — GodownBook" };

export default async function LoginPage() {
  if (await currentUser()) redirect("/app");
  return <AuthPage mode="login" />;
}
