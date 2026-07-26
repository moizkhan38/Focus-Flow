import { SignIn } from '@clerk/clerk-react';
import LogoMark from '../components/shared/Logo';

export default function Login() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-10" style={{ background: '#f9fafb' }}>
      {/* Logo */}
      <div className="mb-8 flex flex-col items-center">
        <LogoMark className="mb-3 h-16 w-16" />
        <h1 className="text-2xl font-bold text-gray-900">Focus Flow</h1>
        <p className="mt-1 text-sm text-gray-500">AI-Powered Sprint Management</p>
      </div>

      <SignIn routing="path" path="/login" signUpUrl="/signup" fallbackRedirectUrl="/projects" />
    </div>
  );
}
