import { redirect } from "next/navigation";

export default function SignUpPage() {
  redirect("/login?error=registration_closed");
}
