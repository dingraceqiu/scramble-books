interface IconProps {
  size?: number | string;
  className?: string;
  strokeWidth?: number;
  /** 选中态：卡片轻填色 + 线条加粗 */
  active?: boolean;
}

/**
 * Feed 瀑布流图标：两列错落的「书摘卡片」如瀑布般向下汇集。
 * - 卡片错落、内置文字行，代表很多书的内容片段；
 * - 底部弧线把两列收成一股向下的水流，表达「像刷瀑布流一样往下刷」。
 * 用 currentColor 绘制：未选中为细线条，选中时卡片轻填色、线条加粗。
 */
export function FeedFlowIcon({ size = 24, className, strokeWidth, active = false }: IconProps) {
  const sw = strokeWidth ?? (active ? 2.1 : 1.7);
  // 选中态：卡片填充当前色的低透明度，形成「填色」感；未选中保持纯线条
  const cardFill = active ? 'currentColor' : 'none';
  const cardFillOpacity = active ? 0.14 : 1;
  const lineOpacity = active ? 0.9 : 0.55;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* 左列卡片：顶窄、中高 */}
      <rect x="3" y="3" width="7.5" height="5" rx="2" fill={cardFill} fillOpacity={cardFillOpacity} />
      <rect x="3" y="10.5" width="7.5" height="8" rx="2" fill={cardFill} fillOpacity={cardFillOpacity} />
      {/* 右列卡片：顶高、底窄（与左列错开，瀑布流错位感） */}
      <rect x="13.5" y="3" width="7.5" height="8" rx="2" fill={cardFill} fillOpacity={cardFillOpacity} />
      <rect x="13.5" y="13.5" width="7.5" height="5" rx="2" fill={cardFill} fillOpacity={cardFillOpacity} />

      {/* 卡片内的文字行（内容片段），未选中时更淡 */}
      <g strokeWidth={sw * 0.66} opacity={lineOpacity}>
        <path d="M5.4 5.5h2.6" />
        <path d="M15.9 5.5h2.6" />
        <path d="M5.4 13h2.6M5.4 15.2h2.6" />
        <path d="M15.9 16h2.6" />
      </g>

      {/* 底部汇集：两列内容汇成一股向下的水流 */}
      <path d="M9 19.4c0 1.1.8 1.6 3 1.6s3-.5 3-1.6" fill="none" />
    </svg>
  );
}
