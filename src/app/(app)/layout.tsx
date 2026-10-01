import { UserButton } from "@clerk/nextjs";
import { requireUser } from "@/lib/auth";
import { teamsOf } from "@/lib/teams";
import { shellData } from "@/lib/shell-data";
import { productLensFor, releaseLensFor } from "@/lib/viewer-flags";
import { AppShell } from "@/components/shell/app-shell";
import { Sidebar } from "@/components/shell/sidebar";

// Every signed-in page renders inside this frame (CHE-351, direction C of
// CHE-348). The public site keeps its own header (src/app/layout.tsx hides it
// on these routes — src/lib/app-shell.ts lists them).
//
// The lenses are decided here, on the server, from the person's flags. The
// client shell is handed the rendered sidebar and never a flag key (CHE-381).
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, db, team } = await requireUser();
  const [teams, data, product, release] = await Promise.all([
    teamsOf(db, user.id),
    shellData(db, team.id),
    productLensFor(user),
    releaseLensFor(user),
  ]);
  const account = <UserButton />;

  return (
    <AppShell
      account={account}
      sidebar={
        <Sidebar
          team={{ id: team.id, name: team.name }}
          teams={teams}
          data={data}
          lenses={{ product, release }}
          account={account}
        />
      }
    >
      {children}
    </AppShell>
  );
}
