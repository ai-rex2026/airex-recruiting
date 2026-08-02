"use client";

import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";
import { btnAccent, btnGhost, btnPrimary, btnSmall } from "@/components/ui";

type Variant = "accent" | "ghost" | "small" | "primary";

const CLS: Record<Variant, string> = {
  accent: btnAccent,
  ghost: btnGhost,
  small: btnSmall,
  primary: btnPrimary,
};

/**
 * 送信中は必ずスピナーを出して二度押しを止めるボタン。
 * 同じ <form> の中に置くこと（useFormStatus が親フォームの状態を読む）。
 */
export default function SubmitButton({
  children,
  variant = "accent",
  pendingLabel,
  className = "",
  name,
  value,
  formAction,
  disabled,
  title,
}: {
  children: ReactNode;
  variant?: Variant;
  pendingLabel?: string;
  className?: string;
  name?: string;
  value?: string;
  formAction?: (formData: FormData) => void | Promise<void>;
  disabled?: boolean;
  title?: string;
}) {
  const { pending } = useFormStatus();
  const small = variant === "small";

  return (
    <button
      type="submit"
      name={name}
      value={value}
      formAction={formAction}
      title={title}
      disabled={pending || disabled}
      className={`${CLS[variant]} ${className} ${pending ? "cursor-wait opacity-70" : ""}`}
    >
      {pending && (
        <span
          className={`mr-2 inline-block animate-spin rounded-full border-2 border-current/30 border-t-current ${
            small ? "h-3 w-3" : "h-3.5 w-3.5"
          }`}
        />
      )}
      {pending ? pendingLabel ?? "処理中…" : children}
    </button>
  );
}
