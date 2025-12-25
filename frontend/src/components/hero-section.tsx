import type { JSX } from "react";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import LoginOutlinedIcon from "@mui/icons-material/LoginOutlined";
import LogoutOutlinedIcon from "@mui/icons-material/LogoutOutlined";
import PersonOutlineOutlinedIcon from "@mui/icons-material/PersonOutlineOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { NQLogo } from "./nq-logo";

type HeroSectionProps = {
  showAuthControls?: boolean;
  authenticated?: boolean;
  userName?: string | null;
  onSignIn?: () => void;
  onSignOut?: () => void;
};

export function HeroSection({
  showAuthControls = true,
  authenticated = false,
  userName,
  onSignIn,
  onSignOut,
}: HeroSectionProps): JSX.Element {
  return (
    <Box component="header" className="nexa-header">
      <Stack direction="row" alignItems="center" spacing={1.6}>
        <NQLogo fontSize="large" sx={{ color: "primary.light" }} />
        <Box>
          <Typography component="h1" variant="h5" sx={{ fontWeight: 600 }}>
            NexaQuill
          </Typography>
          <Typography component="p" variant="body2">
            Realtime knowledge copilot
          </Typography>
        </Box>
      </Stack>
      <Stack direction="row" alignItems="center" spacing={1.2}>
        {!showAuthControls ? (
          <Chip
            label="Demo mode"
            color="success"
            variant="outlined"
            icon={<BoltOutlinedIcon fontSize="small" />}
          />
        ) : authenticated ? (
          <>
            <Chip
              label={userName?.trim() || "Signed in"}
              variant="outlined"
              color="primary"
              icon={<PersonOutlineOutlinedIcon fontSize="small" />}
            />
            <Button
              type="button"
              variant="outlined"
              color="inherit"
              startIcon={<LogoutOutlinedIcon />}
              onClick={onSignOut}
            >
              Sign out
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="contained"
            color="primary"
            startIcon={<LoginOutlinedIcon />}
            onClick={onSignIn}
          >
            Sign in
          </Button>
        )}
      </Stack>
    </Box>
  );
}
