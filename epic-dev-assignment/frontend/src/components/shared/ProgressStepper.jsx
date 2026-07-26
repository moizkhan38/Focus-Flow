import { useWorkflow } from '../../context/WorkflowContext';
import { motion } from 'framer-motion';
import { Check } from 'lucide-react';

const steps = [
  { number: 1, title: 'Generate', label: 'EPICS' },
  { number: 2, title: 'Approve', label: 'REVIEW' },
  { number: 3, title: 'Analyze', label: 'DEVS' },
  { number: 4, title: 'Assign', label: 'MATCH' }
];

export default function ProgressStepper() {
  const { currentStep, setCurrentStep } = useWorkflow();

  const getStepStatus = (stepNumber) => {
    if (stepNumber < currentStep) return 'completed';
    if (stepNumber === currentStep) return 'current';
    return 'upcoming';
  };

  const handleStepClick = (stepNumber) => {
    const status = getStepStatus(stepNumber);
    if (status === 'completed' || status === 'current') {
      setCurrentStep(stepNumber);
    }
  };

  return (
    <div className="w-full max-w-2xl mx-auto">
      <div className="flex items-center">
        {steps.map((step, index) => {
          const status = getStepStatus(step.number);
          const isCompleted = status === 'completed';
          const isCurrent = status === 'current';
          const isUpcoming = status === 'upcoming';

          return (
            <div key={step.number} className="flex items-center flex-1">
              <div className="flex flex-col items-center flex-1">
                <button
                  onClick={() => handleStepClick(step.number)}
                  disabled={isUpcoming}
                  className="relative group"
                >
                  {isCurrent && (
                    <motion.div
                      className="absolute -inset-1.5 rounded-2xl bg-teal-400/20 blur-sm"
                      layoutId="stepGlow"
                      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                    />
                  )}
                  <motion.div
                    className={`
                      relative w-8 h-8 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center
                      text-xs sm:text-sm font-mono font-semibold transition-colors duration-300
                      ${isCompleted ? 'bg-teal-100 text-teal-700 cursor-pointer group-hover:bg-teal-200' : ''}
                      ${isCurrent ? 'bg-teal-500 text-white cursor-pointer' : ''}
                      ${isUpcoming ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : ''}
                    `}
                    whileHover={!isUpcoming ? { scale: 1.08 } : {}}
                    whileTap={!isUpcoming ? { scale: 0.95 } : {}}
                  >
                    {isCompleted ? (
                      <motion.div
                        initial={{ scale: 0, rotate: -45 }}
                        animate={{ scale: 1, rotate: 0 }}
                        transition={{ type: 'spring', stiffness: 400, damping: 15 }}
                      >
                        <Check className="w-4 h-4" strokeWidth={2.5} />
                      </motion.div>
                    ) : (
                      step.number
                    )}
                  </motion.div>
                </button>
                <div className="mt-2 sm:mt-2.5 text-center">
                  <div className={`
                    text-[9px] sm:text-[11px] font-mono uppercase tracking-wide sm:tracking-widest transition-colors duration-300
                    ${isCurrent ? 'text-teal-600' : ''}
                    ${isCompleted ? 'text-teal-500' : ''}
                    ${isUpcoming ? 'text-gray-400' : ''}
                  `}>
                    {step.label}
                  </div>
                  <div className={`
                    text-[10px] sm:text-xs mt-0.5 transition-colors duration-300
                    ${isCurrent ? 'text-gray-900 font-medium' : ''}
                    ${isCompleted ? 'text-gray-500' : ''}
                    ${isUpcoming ? 'text-gray-400' : ''}
                  `}>
                    {step.title}
                  </div>
                </div>
              </div>
              {index < steps.length - 1 && (
                <div className="flex-1 mx-1 -mt-5 sm:-mt-6 relative">
                  <div className="h-px w-full bg-gray-200" />
                  {isCompleted && (
                    <motion.div
                      className="absolute top-0 left-0 h-px bg-gradient-to-r from-teal-400 to-teal-200"
                      initial={{ width: 0 }}
                      animate={{ width: '100%' }}
                      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
