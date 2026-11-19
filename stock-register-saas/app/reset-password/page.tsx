import AuthCard from "@/components/auth/AuthCard";
import ResetForm from "@/components/auth/ResetForm";

export const metadata = { title: "Set a new password — GodownBook", robots: { index: false } };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <AuthCard title="Set a new password" subtitle="Choose a new password for your GodownBook login.">
      <ResetForm token={typeof token === "string" ? token : ""} />
    </AuthCard>
  );
}
