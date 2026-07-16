interface IconProps {
  size?: number;
}

const base = (size = 18) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

export const MoveIcon = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M12 3v18M3 12h18" />
    <path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" />
  </svg>
);

export const BrushIcon = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M20.5 3.5c-2.5 0-8 4.5-10.5 8.5l2 2c4-2.5 8.5-8 8.5-10.5z" />
    <path d="M9.5 12.5c-2 .5-3 2-3.5 4.5-.3 1.5-1.5 2.5-3 3 2 1.5 5.5 1.5 7.5-.5 1.3-1.3 1.5-3 1-4.5z" />
  </svg>
);

export const EraserIcon = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M9 20l-5.5-5.5a1.5 1.5 0 0 1 0-2.1l8.9-8.9a1.5 1.5 0 0 1 2.1 0l5 5a1.5 1.5 0 0 1 0 2.1L11 20" />
    <path d="M6.5 11.5l6 6" />
    <path d="M9 20h11" />
  </svg>
);

export const HandIcon = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11m0-6.5v-1a1.5 1.5 0 0 1 3 0V11m0-5.5a1.5 1.5 0 0 1 3 0V13m0-4.5a1.5 1.5 0 0 1 3 0v6.5a6 6 0 0 1-6 6h-1.8a6 6 0 0 1-4.6-2.2L4 14.8a1.6 1.6 0 0 1 2.4-2L8 14.5" />
  </svg>
);

export const ZoomIcon = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M15.5 15.5L21 21" />
    <path d="M7.5 10.5h6M10.5 7.5v6" />
  </svg>
);

export const MarqueeIcon = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path
      d="M4 4h16v16H4z"
      strokeDasharray="3.2 2.6"
    />
  </svg>
);

export const LassoIcon = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M12 4c4.7 0 8.5 2.3 8.5 5.1s-3.8 5.1-8.5 5.1c-1.3 0-2.6-.2-3.7-.5" />
    <path d="M5.9 12.4C4.4 11.5 3.5 10.4 3.5 9.1 3.5 6.3 7.3 4 12 4" />
    <circle cx="7" cy="14" r="1.9" />
    <path d="M6.3 15.8c-.3 1.9-1.3 3.3-2.9 4" />
  </svg>
);

export const PolyLassoIcon = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M9.5 4l10 2.2-1.8 7.3-9 1.6" />
    <path d="M5.5 12.6L4 8.9l5.5-4.9" />
    <circle cx="7" cy="14" r="1.9" />
    <path d="M6.3 15.8c-.3 1.9-1.3 3.3-2.9 4" />
  </svg>
);

export const EyeIcon = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
    <circle cx="12" cy="12" r="2.5" />
  </svg>
);

export const EyeOffIcon = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 4l16 16" />
    <path d="M9.9 5.2A10.6 10.6 0 0 1 12 5c6.5 0 10 6 10 6a17 17 0 0 1-3 3.5M6.1 6.8A16.6 16.6 0 0 0 2 11s3.5 6 10 6c1.4 0 2.7-.3 3.8-.7" />
  </svg>
);

export const PlusIcon = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const TrashIcon = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
  </svg>
);

export const EyedropperIcon = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M20.7 3.3a2.4 2.4 0 0 0-3.4 0l-3 3-1.1-1.1-1.7 1.7 6.6 6.6 1.7-1.7-1.1-1.1 3-3a2.4 2.4 0 0 0 0-3.4z" />
    <path d="M13.6 8.4L5.5 16.5 4 20l3.5-1.5 8.1-8.1" />
  </svg>
);

export const PenIcon = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M12 2l3 6-3 13-3-13z" />
    <path d="M9 8h6" />
  </svg>
);

export const AirbrushIcon = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 20c2-6 6-10 11-13" />
    <path d="M15 4l5 5-3 1-3-3z" />
    <path d="M9 10l1.5 1.5M7 14l1 1M12 8l2 2" strokeDasharray="0.5 3" />
  </svg>
);

export const SettingsIcon = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 8h10M18 8h2M4 16h2M10 16h10" />
    <circle cx="16" cy="8" r="2" />
    <circle cx="8" cy="16" r="2" />
  </svg>
);
