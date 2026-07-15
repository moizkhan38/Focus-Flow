import { SignUp } from '@clerk/clerk-react';
import { Zap } from 'lucide-react';

export default function Signup() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-10" style={{ background: '#f9fafb' }}>
      {/* Logo */}
      <div className="mb-8 flex flex-col items-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600 shadow-lg">
          <Zap className="h-6 w-6 text-white" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Focus Flow</h1>
        <p className="mt-1 text-sm text-gray-500">AI-Powered Sprint Management</p>
      </div>

      <SignUp routing="path" path="/signup" signInUrl="/login" fallbackRedirectUrl="/projects" />
    </div>
  );
}
