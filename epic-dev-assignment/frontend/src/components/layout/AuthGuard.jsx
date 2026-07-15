import { SignedIn, SignedOut, RedirectToSignIn, useOrganization, OrganizationList } from '@clerk/clerk-react';
import { Loader2 } from 'lucide-react';

// Signed in but no active organization → the user must create or pick one before
// entering the app. All data is org-scoped (B2B model), so there is nothing to
// show without an org. Clerk's "membership required" mode makes this rare, but
// this gate is the in-app guarantee.
function OrgGate({ children }) {
  const { organization, isLoaded } = useOrganization();

  if (!isLoaded) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (!organization) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-gray-50 px-4">
        <div className="text-center">
          <h1 className="text-xl font-semibold text-gray-900">Choose your organization</h1>
          <p className="mt-1 text-sm text-gray-500">
            Select an organization to continue, or create one for your team.
          </p>
        </div>
        <OrganizationList hidePersonal />
      </div>
    );
  }

  return children;
}

export default function AuthGuard({ children }) {
  return (
    <>
      <SignedIn>
        <OrgGate>{children}</OrgGate>
      </SignedIn>
      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>
    </>
  );
}
