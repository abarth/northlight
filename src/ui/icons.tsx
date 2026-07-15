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
    <path d="M12 4c4.7 0 8.5 2.2 8.5 5s-3.8 5-8.5 5c-2 0-3.9-.4-5.3-1.1" strokeDasharray="3 2.4" />
    <path d="M6.7 12.9C4.7 12 3.5 10.6 3.5 9c0-1.5 1-2.8 2.7-3.7" strokeDasharray="3 2.4" />
    <path d="M6.5 13a2 2 0 1 0 0 4c1.4 0 2-1 2-2.4C8.5 12.4 7 11 7 11" />
    <path d="M6.5 17c0 1.7-1 3-2.5 3.5" />
  </svg>
);

export const PolyLassoIcon = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 15L9 4l7 3 4 6-7 2z" strokeDasharray="3 2.4" />
    <path d="M13 15l-6.5 2a2 2 0 1 0 2 2.4" />
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

export const CopyIcon = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <rect x="9" y="9" width="11" height="11" rx="1.5" />
    <path d="M5 15H4a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 4 3h9A1.5 1.5 0 0 1 14.5 4.5V5" />
  </svg>
);

export const UpIcon = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);

export const DownIcon = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M12 5v14M5 12l7 7 7-7" />
  </svg>
);

export const UndoIcon = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M8 5L3 10l5 5" />
    <path d="M3 10h11a7 7 0 0 1 7 7v2" />
  </svg>
);

export const RedoIcon = ({ size }: IconProps) => (
  <svg {...base(size)}>
    <path d="M16 5l5 5-5 5" />
    <path d="M21 10H10a7 7 0 0 0-7 7v2" />
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
