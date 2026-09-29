"use client";

import { useClerk } from "@clerk/nextjs";
import { useRef, type MouseEvent, type ReactNode } from "react";

// #133 put `oidcPrompt="select_account"` on the SignIn mount, and Google still
// signed people straight into whatever account the browser held. The prop is
// read, and then lost: clerk-js 6.34.1 `signIn.authenticateWithRedirect`
// creates the sign-in without it (SignIn.ts, authenticateWithRedirectOrPopup →
// this.create({ strategy, identifier, redirectUrl, actionCompleteRedirectUrl })),
// so FAPI never adds `prompt=select_account`. `signIn.create` with the same
// parameter does — measured on checkmyapp.dev 2026-09-29.
//
// So the Google button keeps Clerk's look and its own callback route, and only
// the start of the flow is ours. Anything we cannot hand to Google ourselves
// (an error, a challenge that has to run first) goes back to Clerk's button,
// which shows its own error or challenge — a sign-in never dead-ends here.
// Sign-up is unaffected: SignUp.ts passes the prompt through.
const GOOGLE_BUTTON = ".cl-socialButtonsBlockButton__google, .cl-socialButtonsIconButton__google";

export function GoogleAccountChooser({ children }: { children: ReactNode }) {
  const clerk = useClerk();
  const handingBack = useRef(false);

  function onClickCapture(event: MouseEvent<HTMLDivElement>) {
    const button = (event.target as Element).closest<HTMLButtonElement>(GOOGLE_BUTTON);
    if (!button || handingBack.current || !clerk.client) return;
    event.preventDefault();
    event.stopPropagation();

    const params = new URLSearchParams(window.location.search);
    const callback = new URL("/sign-in/sso-callback", window.location.origin);
    params.forEach((value, key) => callback.searchParams.set(key, value));

    clerk.client.signIn
      .create({
        strategy: "oauth_google",
        redirectUrl: clerk.buildUrlWithAuth(callback.href),
        actionCompleteRedirectUrl: clerk.buildAfterSignInUrl({ params }),
        oidcPrompt: "select_account",
      })
      .then((signIn) => {
        const { status, externalVerificationRedirectURL } = signIn.firstFactorVerification;
        if (status === "unverified" && externalVerificationRedirectURL) {
          window.location.assign(externalVerificationRedirectURL);
          return;
        }
        handBack(button);
      })
      .catch(() => handBack(button));
  }

  function handBack(button: HTMLButtonElement) {
    handingBack.current = true;
    button.click();
    handingBack.current = false;
  }

  return <div onClickCapture={onClickCapture}>{children}</div>;
}
