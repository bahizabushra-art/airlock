export function AirLockLogo({ className = 'w-7 h-7' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <rect x="2" y="2" width="28" height="28" rx="7" className="fill-blue-600 dark:fill-blue-500" />
      <path
        d="M16 7.5L22.5 10.2V15.4C22.5 19.6 19.7 23.1 16 24.5C12.3 23.1 9.5 19.6 9.5 15.4V10.2L16 7.5Z"
        className="stroke-white"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <rect x="13.5" y="14.5" width="5" height="4.2" rx="1" className="fill-white" />
      <path
        d="M14.3 14.5V13.1C14.3 12.16 15.06 11.4 16 11.4C16.94 11.4 17.7 12.16 17.7 13.1V14.5"
        className="stroke-white"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
