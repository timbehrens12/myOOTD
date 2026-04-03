import { useEffect, useState } from 'react';
import { Image, TouchableOpacity, View, StyleSheet, type ImageStyle, type StyleProp } from 'react-native';
import { Colors } from '../constants/AppTheme';

type Props = {
  uri: string;
  /** Google-style normalized box [ymin, xmin, ymax, xmax] each 0–1000 */
  box2d?: number[] | null;
  width: number;
  height: number;
  onPress?: () => void;
  resizeMode?: 'cover' | 'contain';
};

function sanitizeBox(box: unknown): number[] | null {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const n = box.map((v) => Number(v));
  if (n.some((x) => !Number.isFinite(x))) return null;
  const [ymin, xmin, ymax, xmax] = n;
  if (xmax <= xmin || ymax <= ymin) return null;
  if (ymin < 0 || xmin < 0 || ymax > 1000 || xmax > 1000) return null;
  const area = ((xmax - xmin) * (ymax - ymin)) / 1e6;
  if (area > 0.55) return null;
  return n;
}

/**
 * Shows a zoomed crop of the region around `box2d` (when valid), else full image.
 */
export default function ZoomedItemThumb({
  uri,
  box2d,
  width: containerW,
  height: containerH,
  onPress,
  resizeMode = 'cover',
}: Props) {
  const [imgW, setImgW] = useState(0);
  const [imgH, setImgH] = useState(0);
  const box = sanitizeBox(box2d);

  useEffect(() => {
    let cancelled = false;
    Image.getSize(
      uri,
      (w, h) => {
        if (!cancelled) {
          setImgW(w);
          setImgH(h);
        }
      },
      () => {
        if (!cancelled) {
          setImgW(0);
          setImgH(0);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [uri]);

  const inner =
    !box || !imgW || !imgH ? (
      <Image source={{ uri }} style={StyleSheet.absoluteFillObject} resizeMode={resizeMode} />
    ) : (
      <ZoomedFill uri={uri} box={box} imgW={imgW} imgH={imgH} containerW={containerW} containerH={containerH} />
    );

  if (onPress) {
    return (
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={onPress}
        style={[styles.wrap, { width: containerW, height: containerH }]}
      >
        {inner}
      </TouchableOpacity>
    );
  }

  return <View style={[styles.wrap, { width: containerW, height: containerH }]}>{inner}</View>;
}

function ZoomedFill({
  uri,
  box,
  imgW,
  imgH,
  containerW,
  containerH,
}: {
  uri: string;
  box: number[];
  imgW: number;
  imgH: number;
  containerW: number;
  containerH: number;
}) {
  const [ymin, xmin, ymax, xmax] = box;
  const realW = ((xmax - xmin) / 1000) * imgW;
  const realH = ((ymax - ymin) / 1000) * imgH;
  const cx = ((xmin + xmax) / 2000) * imgW;
  const cy = ((ymin + ymax) / 2000) * imgH;
  const pad = 1.35;
  const targetW = Math.max(realW * pad, 1);
  const targetH = Math.max(realH * pad, 1);
  const containerAspect = containerW / Math.max(containerH, 1);

  let cropW = targetW;
  let cropH = targetH;
  if (cropW / cropH < containerAspect) cropW = cropH * containerAspect;
  else cropH = cropW / containerAspect;

  cropW = Math.min(cropW, imgW);
  cropH = Math.min(cropH, imgH);

  let cropLeft = cx - cropW / 2;
  let cropTop = cy - cropH / 2;
  cropLeft = Math.max(0, Math.min(cropLeft, imgW - cropW));
  cropTop = Math.max(0, Math.min(cropTop, imgH - cropH));

  const scale = Math.max(containerW / Math.max(cropW, 1), containerH / Math.max(cropH, 1));
  const renderW = imgW * scale;
  const renderH = imgH * scale;
  const left = -cropLeft * scale;
  const top = -cropTop * scale;

  return (
    <View style={[styles.wrap, { width: containerW, height: containerH, backgroundColor: Colors.surface }]}>
      <Image
        source={{ uri }}
        style={
          {
            position: 'absolute',
            top,
            left,
            width: renderW,
            height: renderH,
          } as StyleProp<ImageStyle>
        }
        resizeMode="cover"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    overflow: 'hidden',
    borderRadius: 0,
  },
});
