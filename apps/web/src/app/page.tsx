import { redirect } from "next/navigation";
import { currentAuth } from "@/lib/session";

export default async function Home() {
  const auth = await currentAuth();
  redirect(auth ? (auth.role === "doctor" ? "/doctor" : "/dashboard") : "/login");
}
