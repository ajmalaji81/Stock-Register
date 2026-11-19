import AuthCard from "@/components/auth/AuthCard";
import ForgotForm from "@/components/auth/ForgotForm";

export const metadata = { title: "Forgot password — GodownBook" };

export default function ForgotPasswordPage() {
  return (
    <AuthCard title="Forgot your password?" subtitle="Enter the email you log in with. We'll email you a link to set a new password.">
      <ForgotForm />
    </AuthCard>
  );
}
