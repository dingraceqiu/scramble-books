/**
 * Scramble Books 产品 Logo
 * 意象：几页书 / 内容卡片像瀑布一样错落往下流（透明底，彩色书页）。
 * 三张放大的书页卡片阶梯式叠放、自上而下流动，书页内有文字行；
 * 番茄橙 / 青碧 / 芥末金三色，无背景色，亮暗底均清晰。
 */

export interface LogoProps {
  size?: number;
  className?: string;
}

function PageLines({ x, ys, w }: { x: number; ys: number[]; w: number }) {
  return (
    <>
      {ys.map((y, i) => (
        <rect
          key={y}
          x={x}
          y={y}
          width={i === ys.length - 1 ? w * 0.6 : w}
          height={2.6}
          rx={1.3}
          fill="#ffffff"
          opacity={i === 0 ? 0.95 : 0.7}
        />
      ))}
    </>
  );
}

export function BrandMark({ size = 34, className }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <defs>
        <linearGradient id="sb-g-orange" x1="8" y1="5" x2="34" y2="23" gradientUnits="userSpaceOnUse">
          <stop stopColor="#f4774a" />
          <stop offset="1" stopColor="#e85d2c" />
        </linearGradient>
        <linearGradient id="sb-g-teal" x1="16" y1="15" x2="42" y2="33" gradientUnits="userSpaceOnUse">
          <stop stopColor="#55b3a6" />
          <stop offset="1" stopColor="#2f8f83" />
        </linearGradient>
        <linearGradient id="sb-g-gold" x1="10" y1="26" x2="36" y2="44" gradientUnits="userSpaceOnUse">
          <stop stopColor="#eaba55" />
          <stop offset="1" stopColor="#d99f2f" />
        </linearGradient>
      </defs>

      {/* 书页 1（顶部，番茄橙）——左高，瀑布第一叠 */}
      <g transform="rotate(-9 21 14)">
        <rect x="8" y="5" width="26" height="18" rx="4.5" fill="url(#sb-g-orange)" />
        <PageLines x={13} ys={[10.5, 14.5, 18.5]} w={16} />
      </g>

      {/* 书页 2（中部，青碧）——向右下方错落 */}
      <g transform="rotate(7 29 24)">
        <rect x="16" y="15" width="26" height="18" rx="4.5" fill="url(#sb-g-teal)" />
        <PageLines x={21} ys={[20.5, 24.5, 28.5]} w={16} />
      </g>

      {/* 书页 3（底部，芥末金）——回到左下，继续向下流 */}
      <g transform="rotate(-7 23 35)">
        <rect x="10" y="26" width="26" height="18" rx="4.5" fill="url(#sb-g-gold)" />
        <PageLines x={15} ys={[31.5, 35.5, 39.5]} w={16} />
      </g>

      {/* 底部向下的水流箭头，点明“往下刷” */}
      <path
        d="M24 43.5 L24 46.8 M21 45 L24 47.6 L27 45"
        stroke="#e85d2c"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default BrandMark;
/** 别名，便于按语义引用 */
export const BrandLogo = BrandMark;
