"use client";

import { useId } from "react";
import type { JSX } from "react";
import SvgIcon, { type SvgIconProps } from "@mui/material/SvgIcon";
import { useTheme } from "@mui/material/styles";

export function NQLogo(props: SvgIconProps): JSX.Element {
  const gradientId = useId();
  const theme = useTheme();
  const primary = theme.palette.primary.main;
  const accent = theme.palette.mode === "dark" ? theme.palette.info.light : theme.palette.info.main;

  return (
    <SvgIcon viewBox="0 0 32 32" {...props}>
      <defs>
        <linearGradient id={`${gradientId}-nq`} x1="4" y1="6" x2="28" y2="26" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={primary} />
          <stop offset="100%" stopColor={accent} />
        </linearGradient>
      </defs>
      <path
        d="M4 26V6h4l9 12V6h4v20h-4l-9-12v12H4z"
        fill={`url(#${gradientId}-nq)`}
        opacity="0.92"
      />
      <circle cx="23" cy="12" r="7" stroke="currentColor" strokeWidth="2" fill="none" />
      <circle cx="23" cy="12" r="4" fill={`url(#${gradientId}-nq)`} opacity="0.6" />
      <path d="M27 16.5L30 20.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </SvgIcon>
  );
}
