import { SignIn } from "@clerk/nextjs";
import { GoogleAccountChooser } from "@/components/google-account-chooser";

// Clerk-hosted sign-in mounted on a catch-all so every sub-step (factor-two,
// SSO callbacks) resolves under /sign-in. email-code is the agent-walkable path
// used by the dogfood self-check (CHE-35).
//
// CHE-276: `oidcPrompt="select_account"` makes Google ask WHICH account. Without
// it Google silently reuses whichever account the browser is signed into — for a
// Chrome profile synced to a work account, "Continue with Google" is not a
// choice, it is an announcement. It also made a second account unreachable,
// which is what accepting a team invitation needs (CHE-265). The prop alone does
// not reach Google on sign-in — see GoogleAccountChooser.
export default function SignInPage() {
  return (
    <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-4 py-16">
      <GoogleAccountChooser>
        <SignIn oidcPrompt="select_account" />
      </GoogleAccountChooser>
    </main>
  );
}
