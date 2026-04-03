import { View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

const SEGMENT_COLORS = [
  '#FFD60A',
  '#FF9F0A',
  '#FF453A',
  '#FF375F',
  '#BF5AF2',
  '#5E5CE6',
  '#0A84FF',
  '#64D2FF',
  '#32D74B',
  '#30D158',
  '#34C759',
  '#FFD60A',
];

function ringSegmentPath(
  index: number,
  total: number,
  cx: number,
  cy: number,
  rOut: number,
  rIn: number,
): string {
  const a0 = (index / total) * 2 * Math.PI - Math.PI / 2;
  const a1 = ((index + 1) / total) * 2 * Math.PI - Math.PI / 2;
  const x0 = cx + rOut * Math.cos(a0);
  const y0 = cy + rOut * Math.sin(a0);
  const x1 = cx + rOut * Math.cos(a1);
  const y1 = cy + rOut * Math.sin(a1);
  const x2 = cx + rIn * Math.cos(a1);
  const y2 = cy + rIn * Math.sin(a1);
  const x3 = cx + rIn * Math.cos(a0);
  const y3 = cy + rIn * Math.sin(a0);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${x0} ${y0} A ${rOut} ${rOut} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${rIn} ${rIn} 0 ${large} 0 ${x3} ${y3} Z`;
}

type Props = {
  size?: number;
};

/** iOS-style rainbow ring with white center (tap target for opening the color picker). */
export default function ColorPickerTriggerIcon({ size = 32 }: Props) {
  const vb = 48;
  const cx = vb / 2;
  const cy = vb / 2;
  const rOut = 22;
  const rIn = 14;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} viewBox={`0 0 ${vb} ${vb}`}>
        {SEGMENT_COLORS.map((fill, i) => (
          <Path key={i} d={ringSegmentPath(i, SEGMENT_COLORS.length, cx, cy, rOut, rIn)} fill={fill} />
        ))}
        <Circle cx={cx} cy={cy} r={rIn - 1.25} fill="#FFFFFF" />
      </Svg>
    </View>
  );
}
