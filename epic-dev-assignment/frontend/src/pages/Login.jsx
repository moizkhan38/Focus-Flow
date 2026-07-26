import { SignIn } from '@clerk/clerk-react';
import LogoMark, { Wordmark } from '../components/shared/Logo';
import { authIntro, authIntroItem } from '../components/shared/authMotion';
import { motion } from 'framer-motion';

export default function Login() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-10" style={{ background: '#f9fafb' }}>
      {/* Logo */}
      <motion.div className="mb-8 flex flex-col items-center" {...authIntro}>
        <motion.div variants={authIntroItem}>
          <LogoMark className="mb-3 h-16 w-16" />
        </motion.div>
        <motion.h1 variants={authIntroItem} className="text-2xl font-bold"><Wordmark /></motion.h1>
        <motion.p variants={authIntroItem} className="mt-1 text-center text-sm text-brand-slate">
          AI-Powered Scrum Master Automation Tool
        </motion.p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.28, ease: [0.16, 1, 0.3, 1] }}
      >
        <SignIn routing="path" path="/login" signUpUrl="/signup" fallbackRedirectUrl="/projects" />
      </motion.div>
    </div>
  );
}
