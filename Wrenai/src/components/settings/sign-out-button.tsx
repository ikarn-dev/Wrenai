"use client";

import { LogOut } from "lucide-react";
import type { ReactElement } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

/** The submit button of the sign-out form: a spinner replaces its label while the session ends. */
export function SignOutButton(): ReactElement {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="destructive" busy={pending}>
      <LogOut aria-hidden="true" size={16} strokeWidth={1.75} absoluteStrokeWidth />
      Sign out
    </Button>
  );
}
