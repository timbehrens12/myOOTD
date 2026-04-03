import { useState, useCallback, useMemo } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, Dimensions, ScrollView, Alert, ActivityIndicator, Image, KeyboardAvoidingView, Platform, Modal, TextInput } from 'react-native';
import { useRouter } from 'expo-router';
import { Colors } from '../constants/AppTheme';
import { OCCASION_GROUPS } from '../constants/occasions';
import { LinearGradient } from 'expo-linear-gradient';
const BlurView = require('expo-blur').BlurView as any;
import Animated, { FadeIn, FadeInRight, FadeOutLeft, FadeInDown, Layout, SlideInUp } from 'react-native-reanimated';
import { useAuth, useUser } from '@clerk/clerk-expo';
import { supabase } from '../lib/supabase';
import * as ImagePicker from 'expo-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';

const { width, height } = Dimensions.get('window');

// --- Components ---

const StepIndicator = ({ step, total }: { step: number, total: number }) => (
  <View style={styles.indicatorContainer}>
    {Array.from({ length: total }, (_, i) => i + 1).map((s) => (
      <View 
        key={s} 
        style={[
          styles.indicatorLine,
          s <= step ? { backgroundColor: '#000' } : { backgroundColor: 'rgba(0,0,0,0.1)' },
          s === step && { width: 32 }
        ]} 
      />
    ))}
  </View>
);

const FormCard = ({ title, active, onPress, style }: { title: string, active: boolean, onPress: () => void, style?: any }) => (
  <TouchableOpacity 
    style={[styles.formCard, active && styles.formCardActive, style]} 
    onPress={onPress}
    activeOpacity={0.8}
  >
    <Text style={[styles.formCardLabel, active && styles.formCardLabelActive]}>{title}</Text>
    <View style={[styles.radioOuter, active && styles.radioOuterActive]}>
       {active && <View style={styles.radioInner} />}
    </View>
  </TouchableOpacity>
);

const StyleChip = ({ title, active, onPress }: { title: string, active: boolean, onPress: () => void }) => (
  <TouchableOpacity 
    style={[styles.styleChip, active && styles.styleChipActive]} 
    onPress={onPress}
    activeOpacity={0.7}
  >
    <Text style={[styles.styleChipText, active && styles.styleChipTextActive]}>{title}</Text>
  </TouchableOpacity>
);

const ZoomedItem = ({ uri, box, imgWidth, imgHeight, size = 110, onPress }: { uri: string, box: number[], imgWidth?: number, imgHeight?: number, size?: number, onPress?: () => void }) => {
  if (!box || box.length !== 4 || !imgWidth || !imgHeight) return (
    <TouchableOpacity activeOpacity={0.9} onPress={onPress}>
      <Image source={{ uri }} style={{ width: size, height: size, borderRadius: 12 }} resizeMode="contain" />
    </TouchableOpacity>
  );
  
  const [ymin, xmin, ymax, xmax] = box;
  
  const boxAreaPerc = ((xmax - xmin) * (ymax - ymin)) / 10000;
  if (boxAreaPerc > 50 || (xmax - xmin) > 800 || (ymax - ymin) > 800) {
    return (
      <TouchableOpacity activeOpacity={0.9} onPress={onPress}>
        <Image source={{ uri }} style={{ width: size, height: size, borderRadius: 12 }} resizeMode="contain" />
      </TouchableOpacity>
    );
  }

  const realBoxWidth = (xmax - xmin) / 1000 * imgWidth;
  const realBoxHeight = (ymax - ymin) / 1000 * imgHeight;
  const realCenterX = (xmin + xmax) / 2000 * imgWidth;
  const realCenterY = (ymin + ymax) / 2000 * imgHeight;

  const paddedDim = Math.max(realBoxWidth, realBoxHeight) * 1.5; 
  const scale = size / paddedDim;
  
  const renderWidth = imgWidth * scale;
  const renderHeight = imgHeight * scale;
  
  const leftOffset = (size / 2) - (realCenterX * scale);
  const topOffset = (size / 2) - (realCenterY * scale);

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.9} style={{ width: size, height: size, overflow: 'hidden', borderRadius: 12, backgroundColor: Colors.surfaceAlt }}>
      <Image 
        source={{ uri }} 
        style={{
          position: 'absolute',
          top: topOffset,
          left: leftOffset,
          width: renderWidth,
          height: renderHeight,
        }}
        resizeMode="stretch"
      />
    </TouchableOpacity>
  );
};

// --- Main Screen ---

export default function SurveyScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { userId } = useAuth();
  const { user } = useUser();
  
  const [step, setStep] = useState(1);
  const totalSteps = 3; 
  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState('');

  const [selections, setSelections] = useState<any>({
    gender: '', 
    age: '',
    source: '',
    vibe: [],
    inspoImages: [],
    seedItems: [] 
  });


  const [reviewItems, setReviewItems] = useState<any[]>([]); 
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [showReview, setShowReview] = useState(false);

  // Edit Modal State
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [fullScreenUri, setFullScreenUri] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: '', category: '', color: '' });

  const isNextDisabled = () => {
    if (step === 1) return !selections.gender || !selections.age || !selections.source;
    if (step === 2) return selections.inspoImages.length === 0 && selections.vibe.length === 0;
    return false;
  };

  const uploadToSupabase = async (uri: string, bucket: string) => {
     try {
       const response = await fetch(uri);
       const blob = await response.blob();
       const ext = uri.substring(uri.lastIndexOf('.') + 1) || 'jpeg';
       const fileName = `${userId}-${Date.now().toString()}-${Math.random().toString(36).substring(7)}.${ext}`;
       const { data, error } = await supabase.storage.from(bucket).upload(fileName, blob, { contentType: `image/${ext}` });
       if (error) throw error;
       const { data: publicUrlData } = supabase.storage.from(bucket).getPublicUrl(fileName);
       return publicUrlData.publicUrl;
     } catch (e) { return null; }
  };

  const finalize = async () => {
    if (!userId) return;
    setLoading(true);
    setStatusText('Digitizing your fits...');
    try {
      const inspoUrls = [];
      for(const uri of selections.inspoImages) {
        const url = await uploadToSupabase(uri, 'style_inspo');
        if (url) inspoUrls.push(url);
      }
      for(const item of selections.seedItems) {
        const url = await uploadToSupabase(item.uri, 'closet_items');
        if (url) {
          await supabase.from('clothing_items').insert({
            user_id: userId, 
            image_url: url, 
            category: item.category || 'Other', 
            sub_category: item.sub_category || null,
            name: item.name || 'Item', 
            color: item.color || null,
            material: item.material || null,
            seasons: item.season ? [item.season] : (item.seasons || null),
            box_2d: item.box_2d || null,
            is_digitized: true
          });
        }
      }
      const mannequinGender = selections.gender === 'Prefer not to say' ? 'Menswear' : (selections.gender === 'Man' ? 'Menswear' : 'Womenswear');
      await supabase.from('profiles').upsert({
        user_id: userId,
        gender: mannequinGender,
        age_range: selections.age,
        acquisition_source: selections.source,
        style_archetypes: selections.vibe,
        style_inspiration_urls: inspoUrls,
      });
      setStatusText('Setting up your closet...');
      await new Promise(r => setTimeout(r, 1000));
      router.replace('/(tabs)');
    } catch (err) { Alert.alert('Error', 'Save failure'); } finally { setLoading(false); }
  };

  const organizeBatch = async (assets: any[]) => {
    setIsAnalyzing(true);
    setStatusText(`Analyzing 1 of ${assets.length}...`);
    const allResults: any[] = [];
    
    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      setStatusText(`Analyzing ${i + 1} of ${assets.length}...`);
      try {
        const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: 'base64' });
        const apiKey = process.env.EXPO_PUBLIC_OPENAI_API_KEY;
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: 'Detect fashion items. Return JSON: { "items": [ { "name": "Extremely descriptive name. Include brand if clearly visible (e.g. North Face Black Puffer)", "category": "top|bottom|full body|outerwear|shoes|bag|accessory", "sub_category": "...", "color": "...", "material": "...", "fit": "Oversized|Slim|etc", "weight": "Lightweight|Heavy|etc", "pattern": "solid|striped|etc", "style": "...", "seasons": ["spring", "summer"], "occasions": ["casual", "work", "school", "gym", "night-out", "travel", "formal"], "formality": "...", "box_2d": [ymin, xmin, ymax, xmax] } ] }. Normalized boxes 0-1000.' },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }
              ]
            }],
            response_format: { type: "json_object" }
          })
        });
        const data = await response.json();
        const content = JSON.parse(data.choices[0].message.content);
        allResults.push(...content.items.map((it: any) => ({ 
          ...it, 
          uri: asset.uri, 
          imgWidth: asset.width, 
          imgHeight: asset.height,
          occasions: Array.isArray(it.occasions) ? it.occasions : ['casual'] // Ensure array
        })));
      } catch (e) {
        allResults.push({ uri: asset.uri, imgWidth: asset.width, imgHeight: asset.height, name: 'Imported Item', category: 'Other', color: 'Unknown', box_2d: null, occasions: ['casual'] });
      }
    }
    
    setReviewItems(prev => [...prev, ...allResults]);
    setIsAnalyzing(false);
    setShowReview(true);
  };

  const handleSelectImageBatch = async (mode: 'camera' | 'gallery') => {
    const opts: ImagePicker.ImagePickerOptions = { quality: 0.7, allowsMultipleSelection: mode === 'gallery' };
    
    if (mode === 'gallery') {
      const result = await ImagePicker.launchImageLibraryAsync(opts);
      if (!result.canceled && result.assets?.length) {
        organizeBatch(result.assets);
      }
    } else {
      const batch: any[] = [];
      let taking = true;
      while (taking) {
        const result = await ImagePicker.launchCameraAsync({ quality: 0.7 });
        if (!result.canceled && result.assets?.[0]) {
          batch.push(result.assets[0]);
          const another = await new Promise(resolve => {
            Alert.alert('Snap Saved!', `You've taken ${batch.length} photo(s).`, [
              { text: 'Take Another', onPress: () => resolve(true) },
              { text: 'Analyze All', onPress: () => resolve(false), style: 'default' }
            ]);
          });
          if (!another) taking = false;
        } else {
          taking = false;
        }
      }
      if (batch.length > 0) organizeBatch(batch);
    }
  };

  const confirmItems = () => {
    setSelections((prev: any) => ({ ...prev, seedItems: [...prev.seedItems, ...reviewItems] }));
    setReviewItems([]);
    setShowReview(false);
  };

  const pickInspo = async () => {
    let result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, quality: 0.8 });
    if (!result.canceled && result.assets) {
      setSelections((prev: any) => ({ ...prev, inspoImages: [...prev.inspoImages, ...result.assets.map(a => a.uri)] }));
    }
  };

  const openEdit = (idx: number) => {
    const item = reviewItems[idx];
    setEditForm({ name: item.name || '', category: item.category || '', color: item.color || '' });
    setEditIndex(idx);
  };

  const saveEdit = () => {
    if (editIndex !== null) {
      const updated = [...reviewItems];
      updated[editIndex] = { ...updated[editIndex], ...editForm };
      setReviewItems(updated);
    }
    setEditIndex(null);
  };

  const next = () => { if (step < totalSteps) setStep(step + 1); };
  const back = () => { if (step > 1) setStep(step - 1); };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.container}>
      {loading && (
        <View style={styles.loadingOverlay}>
          <BlurView style={StyleSheet.absoluteFillObject} intensity={80} tint="light" />
          <View style={styles.loaderCenter}>
             <ActivityIndicator size="large" color="#000" />
             <Text style={styles.loaderStatus}>{statusText}</Text>
          </View>
        </View>
      )}

      {isAnalyzing && (
        <View style={styles.analysisOverlay}>
          <BlurView style={StyleSheet.absoluteFillObject} intensity={40} tint="light" />
          <ActivityIndicator size="large" color="#000" />
          <Text style={styles.loaderStatus}>{statusText}</Text>
        </View>
      )}

      {/* Edit Item Modal */}
      <Modal visible={editIndex !== null} transparent animationType="fade">
        <View style={styles.editBackdrop}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.editContainer}>
            <View style={styles.editCard}>
              <Text style={styles.editTitle}>Edit Details</Text>
              
              <Text style={styles.editLabel}>Name</Text>
              <TextInput 
                style={styles.editInput} 
                value={editForm.name} 
                onChangeText={t => setEditForm(prev => ({...prev, name: t}))} 
                placeholderTextColor="rgba(0,0,0,0.3)"
                placeholder="e.g. Vintage Wash Tee"
              />

              <Text style={styles.editLabel}>Category</Text>
              <TextInput 
                style={styles.editInput} 
                value={editForm.category} 
                onChangeText={t => setEditForm(prev => ({...prev, category: t}))}
                placeholderTextColor="rgba(0,0,0,0.3)"
              />

              <Text style={styles.editLabel}>Color</Text>
              <TextInput
                style={styles.editInput}
                value={editForm.color}
                onChangeText={t => setEditForm(prev => ({...prev, color: t}))}
                placeholderTextColor="rgba(0,0,0,0.3)"
                placeholder="e.g. Navy Blue"
              />

              <View style={styles.editActions}>
                 <TouchableOpacity style={styles.editCancelBtn} onPress={() => setEditIndex(null)}>
                    <Text style={styles.editCancelText}>Cancel</Text>
                 </TouchableOpacity>
                 <TouchableOpacity style={styles.editSaveBtn} onPress={saveEdit}>
                    <Text style={styles.editSaveText}>Save</Text>
                 </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>

      {/* Main Review Modal */}
      <Modal visible={showReview && editIndex === null} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
           <BlurView intensity={95} tint="light" style={styles.modalContent}>
              <View style={[styles.modalHeader, { paddingTop: insets.top + 20 }]}>
                 <Text style={styles.modalTitle}>Review Items</Text>
                 <Text style={styles.modalSubtitle}>Check the details before these hit your closet.</Text>
              </View>

              <ScrollView contentContainerStyle={styles.reviewScroll}>
                 {reviewItems.map((item, idx) => (
                    <Animated.View key={idx} entering={FadeInDown.delay(idx * 100)} style={styles.reviewCard}>
                       {item.box_2d ? (
                         <ZoomedItem uri={item.uri} box={item.box_2d} imgWidth={item.imgWidth} imgHeight={item.imgHeight} size={110} onPress={() => setFullScreenUri(item.uri)} />
                       ) : (
                         <TouchableOpacity onPress={() => setFullScreenUri(item.uri)} activeOpacity={0.9}>
                           <Image source={{ uri: item.uri }} style={{width: 110, height: 110, borderRadius: 12}} />
                         </TouchableOpacity>
                       )}
                       
                          <View style={styles.reviewMeta}>
                             <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start'}}>
                                <View style={{flex: 1, paddingRight: 8}}>
                                  <Text style={styles.reviewName} numberOfLines={2}>{item.name}</Text>
                                  <Text style={styles.reviewTypeLabel}>{item.sub_category || item.category} • {item.color}</Text>
                                  <View style={styles.miniOccasionGrid}>
                                     {OCCASION_GROUPS.map(group => (
                                       <View key={group.id}>
                                         <Text style={styles.miniOccasionGroupLabel}>{group.label}</Text>
                                         <View style={styles.miniOccasionGroupRow}>
                                           {group.occasions.map(occ => {
                                             const isTagged = (item.occasions || []).map((o: string) => o.toLowerCase()).includes(occ.id.toLowerCase());
                                             return (
                                               <TouchableOpacity
                                                 key={occ.id}
                                                 style={[styles.miniOccasionChip, isTagged && styles.miniOccasionChipActive]}
                                                 onPress={() => {
                                                   const updated = [...reviewItems];
                                                   const itemToUpdate = updated[idx];
                                                   const currentOccs: string[] = itemToUpdate.occasions || [];
                                                   if (isTagged) {
                                                     itemToUpdate.occasions = currentOccs.filter((o: string) => o.toLowerCase() !== occ.id.toLowerCase());
                                                   } else {
                                                     itemToUpdate.occasions = [...currentOccs, occ.id];
                                                   }
                                                   setReviewItems(updated);
                                                 }}
                                               >
                                                 <Text style={[styles.miniOccasionChipText, isTagged && styles.miniOccasionChipTextActive]}>{occ.label}</Text>
                                               </TouchableOpacity>
                                             );
                                           })}
                                         </View>
                                       </View>
                                     ))}
                                  </View>
                                </View>
                                <TouchableOpacity style={{padding: 4}} onPress={() => setReviewItems(prev => prev.filter((_, i) => i !== idx))}>
                                   <Ionicons name="trash-outline" size={20} color="#FF453A" />
                                </TouchableOpacity>
                             </View>
                          </View>
                    </Animated.View>
                 ))}
              </ScrollView>

              <View style={[styles.modalFooter, { paddingBottom: insets.bottom + 20 }]}>
                 <View style={styles.footerRow}>
                   <TouchableOpacity style={styles.addMoreBtn} onPress={() => { setShowReview(false); handleSelectImageBatch('gallery'); }}>
                      <Ionicons name="add" size={20} color="#000" />
                      <Text style={styles.addMoreBtnText}>Add more</Text>
                   </TouchableOpacity>
                   <TouchableOpacity style={styles.confirmBtn} onPress={confirmItems}>
                      <Text style={styles.confirmBtnText}>Save to Closet</Text>
                   </TouchableOpacity>
                 </View>
              </View>
           </BlurView>
        </View>
      </Modal>

      <LinearGradient colors={['#F2F2F7', '#FFFFFF']} style={StyleSheet.absoluteFillObject} />
      
      <View style={[styles.header, { paddingTop: insets.top + 16 }]}>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={back} style={styles.backBtn}>
            {step > 1 && <Text style={styles.backText}>Back</Text>}
          </TouchableOpacity>
          <StepIndicator step={step} total={totalSteps} />
          <Text style={styles.stepCountText}>{step}/{totalSteps}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {step === 1 && (
          <Animated.View entering={FadeInRight} style={styles.stepContent}>
            <Text style={styles.title}>About You.</Text>
            <Text style={styles.subtitle}>Help us set up your digital wardrobe.</Text>
            <Text style={styles.sectionTitle}>Gender</Text>
            <View style={styles.optionGrid}>
              {['Man', 'Woman', 'Prefer not to say'].map((v) => (
                <FormCard key={v} title={v} active={selections.gender === v} onPress={() => setSelections({...selections, gender: v})} style={v === 'Prefer not to say' ? { width: '100%' } : { width: '48.5%' }} />
              ))}
            </View>
            <Text style={[styles.sectionTitle, { marginTop: 18 }]}>Age Group</Text>
            <View style={styles.optionGrid}>
              {['Under 18', '18-24', '25-34', '35-44', '45-54', '55+'].map((v) => (
                <FormCard key={v} title={v} active={selections.age === v} onPress={() => setSelections({...selections, age: v})} style={{ width: '48.5%' }} />
              ))}
            </View>
            <Text style={[styles.sectionTitle, { marginTop: 18 }]}>How did you find us?</Text>
            <View style={styles.optionGrid}>
              {['TikTok', 'IG / FB', 'YouTube', 'Friend', 'Other'].map((v) => (
                <FormCard key={v} title={v} active={selections.source === v} onPress={() => setSelections({...selections, source: v})} style={v === 'Other' ? { width: '100%' } : { width: '48.5%' }} />
              ))}
            </View>
          </Animated.View>
        )}

        {step === 2 && (
          <Animated.View entering={FadeInRight} style={styles.stepContent}>
            <Text style={styles.title}>Your Style.</Text>
            <Text style={styles.subtitle}>Let our AI scan your favorite fits or select the vibes that speak to you.</Text>
            
            <TouchableOpacity style={styles.heroAnalyze} onPress={pickInspo} activeOpacity={0.9}>
               <BlurView intensity={30} tint="extraLight" style={styles.heroInner}>
                  <View style={{flexDirection: 'row', alignItems: 'center', gap: 12}}>
                    <View style={styles.heroIconBox}>
                       <Ionicons name="sparkles" size={20} color="#000" />
                    </View>
                    <View style={{flex: 1}}>
                      <Text style={styles.heroTitle}>AI Style Scan</Text>
                      <Text style={styles.heroDesc}>Upload 3-5 fits for a deep aesthetic analysis.</Text>
                    </View>
                  </View>
                  {selections.inspoImages.length > 0 && (
                    <View style={styles.heroSummary}><Text style={styles.heroSummaryText}>{selections.inspoImages.length} images uploaded</Text></View>
                  )}
               </BlurView>
            </TouchableOpacity>

            <Text style={[styles.sectionTitle, { marginTop: 16 }]}>Or select your vibes:</Text>
            <View style={styles.styleGrid}>
               {[
                 'Minimalist', 'Streetwear', 'Old Money', 'Gorpcore', 
                 'Quiet Luxury', 'Athleisure', 'Vintage', 'Cyberpunk',
                 'Preppy', 'Bohemian', 'Grunge', 'Y2K',
                 'Academic', 'Alternative', 'Classic', 'Sporty'
               ].map((style) => (
                 <StyleChip key={style} title={style} active={selections.vibe.includes(style)} onPress={() => {
                   setSelections((prev: any) => ({ ...prev, vibe: prev.vibe.includes(style) ? prev.vibe.filter((s: string) => s !== style) : [...prev.vibe, style] }));
                 }} />
               ))}
            </View>
          </Animated.View>
        )}

        {step === 3 && (
          <Animated.View entering={FadeInRight} style={styles.stepContent}>
            <Text style={styles.title}>Build your closet ✨</Text>
            <Text style={styles.subtitle}>Snap single items or upload full outfit pics—our system will automatically organize every piece into your digital closet for you.</Text>
            <View style={styles.closetGrid}>
               {Array.from({ length: 3 }).map((_, i) => {
                  const item = selections.seedItems[i];
                  return (
                    <Animated.View key={i} layout={Layout.duration(180)} entering={FadeIn.duration(220)} style={styles.closetSlot}>
                       {item ? (
                         <>
                           <Image source={{ uri: item.uri }} style={styles.slotImg} blurRadius={item.box_2d ? 20 : 0} />
                           {item.box_2d && <View style={StyleSheet.absoluteFill}><ZoomedItem uri={item.uri} box={item.box_2d} size={width / 3.3} onPress={() => setFullScreenUri(item.uri)} /></View>}
                           {!item.box_2d && <TouchableOpacity onPress={() => setFullScreenUri(item.uri)} style={StyleSheet.absoluteFill} />}
                           <View style={styles.slotBadge}><Text style={styles.slotBadgeText}>{item.category}</Text></View>
                         </>
                       ) : (
                         <View style={styles.slotPlaceholder}>
                            <Ionicons name={i === 0 ? "shirt-outline" : i === 1 ? "cut-outline" : "walk-outline"} size={26} color="rgba(0,0,0,0.08)" />
                         </View>
                       )}
                    </Animated.View>
                  );
               })}
            </View>
            <View style={styles.uploadBox}>
               <TouchableOpacity style={styles.uploadBtnMain} onPress={() => handleSelectImageBatch('camera')}>
                  <Ionicons name="camera" size={24} color="#000" />
                  <Text style={styles.uploadBtnTextMain}>Take Photo</Text>
               </TouchableOpacity>
               <TouchableOpacity style={styles.uploadBtnSec} onPress={() => handleSelectImageBatch('gallery')}>
                  <Ionicons name="images" size={24} color="#000" />
                  <Text style={styles.uploadBtnTextSec}>Camera Roll</Text>
               </TouchableOpacity>
            </View>
            <TouchableOpacity style={styles.miniSkip} onPress={() => router.replace('/(tabs)')}>
               <Text style={styles.miniSkipText}>Skip setup for now</Text>
            </TouchableOpacity>
          </Animated.View>
        )}
      </ScrollView>
      <View style={[styles.controlBar, { paddingBottom: insets.bottom + 16 }]}>
         <TouchableOpacity style={[styles.nextAction, (loading || isNextDisabled()) && { opacity: 0.5 }]} onPress={step < totalSteps ? next : finalize} disabled={loading || isNextDisabled()}>
            {loading ? <ActivityIndicator color="#000" /> : <Text style={styles.nextActionText}>{step < totalSteps ? 'Next Step' : 'Let\'s Go'}</Text>}
         </TouchableOpacity>
      </View>

      <Modal visible={!!fullScreenUri} transparent animationType="fade">
        <View style={styles.fullScreenBackdrop}>
           <BlurView intensity={100} tint="light" style={StyleSheet.absoluteFillObject} />
           <TouchableOpacity style={styles.fullScreenClose} onPress={() => setFullScreenUri(null)}>
              <Ionicons name="close" size={28} color="#000" />
           </TouchableOpacity>
           {fullScreenUri && (
             <Image source={{ uri: fullScreenUri }} style={styles.fullScreenImg} resizeMode="contain" />
           )}
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  loadingOverlay: { ...StyleSheet.absoluteFillObject, zIndex: 100, justifyContent: 'center', alignItems: 'center' },
  analysisOverlay: { ...StyleSheet.absoluteFillObject, zIndex: 200, justifyContent: 'center', alignItems: 'center', gap: 16 },
  loaderCenter: { gap: 16, alignItems: 'center' },
  loaderStatus: { color: '#000', fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  header: { paddingHorizontal: 20 },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 40 },
  backBtn: { width: 60 },
  backText: { color: 'rgba(0,0,0,0.4)', fontSize: 13, fontWeight: '600' },
  indicatorContainer: { flexDirection: 'row', gap: 5, flex: 1, justifyContent: 'center' },
  indicatorLine: { height: 2.5, width: 14, borderRadius: 2, backgroundColor: 'rgba(0,0,0,0.1)' },
  stepCountText: { width: 60, textAlign: 'right', color: 'rgba(0,0,0,0.3)', fontSize: 11, fontWeight: '700' },
  scroll: { paddingTop: 16, paddingHorizontal: 20, paddingBottom: 130 },
  stepContent: { gap: 6 },
  title: { fontSize: 34, fontWeight: '800', color: '#000', letterSpacing: -1.2 },
  subtitle: { fontSize: 14, color: 'rgba(0,0,0,0.4)', lineHeight: 18, marginBottom: 16 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: 'rgba(0,0,0,0.6)', marginBottom: 8, textTransform: 'uppercase' },
  optionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between' },
  formCard: { padding: 14, borderRadius: 18, backgroundColor: Colors.surfaceAlt, borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  formCardActive: { backgroundColor: Colors.surface, borderColor: 'rgba(0,0,0,0.2)' },
  formCardLabel: { fontSize: 15, fontWeight: '600', color: 'rgba(0,0,0,0.3)' },
  formCardLabelActive: { color: '#000' },
  radioOuter: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.2, borderColor: 'rgba(0,0,0,0.1)', justifyContent: 'center', alignItems: 'center' },
  radioOuterActive: { borderColor: '#000' },
  radioInner: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#000' },
  styleGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  styleChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, backgroundColor: Colors.surfaceAlt, borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)' },
  styleChipActive: { backgroundColor: '#000', borderColor: '#000' },
  styleChipText: { color: 'rgba(0,0,0,0.4)', fontSize: 13, fontWeight: '600' },
  styleChipTextActive: { color: '#FFF' },
  
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)' },
  modalContent: { flex: 1 },
  modalHeader: { paddingHorizontal: 24, marginBottom: 16, alignItems: 'center' },
  modalTitle: { fontSize: 28, fontWeight: '800', color: '#000', letterSpacing: -1 },
  modalSubtitle: { fontSize: 14, color: 'rgba(0,0,0,0.4)', marginTop: 4, textAlign: 'center' },
  
  reviewScroll: { paddingHorizontal: 20, gap: 14, paddingBottom: 100 },
  reviewCard: {
    backgroundColor: Colors.surfaceAlt,
    borderRadius: 16,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.08)'
  },
  reviewMeta: { flex: 1, paddingVertical: 4 },
  reviewName: { color: '#000', fontSize: 16, fontWeight: '700', marginBottom: 2, lineHeight: 20 },
  reviewTypeLabel: { color: 'rgba(0,0,0,0.4)', fontSize: 12, fontWeight: '600', marginBottom: 8, textTransform: 'uppercase' },
  reviewDetails: { color: 'rgba(0,0,0,0.5)', fontSize: 13, fontWeight: '500' },
  miniOccasionGrid: { gap: 8, marginTop: 4 },
  miniOccasionGroupLabel: { fontSize: 8, fontWeight: '900', color: 'rgba(0,0,0,0.3)', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 4 },
  miniOccasionGroupRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  miniOccasionChip: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: 'rgba(0,0,0,0.04)', borderWidth: 1, borderColor: 'rgba(0,0,0,0.08)' },
  miniOccasionChipActive: { backgroundColor: '#000', borderColor: '#000' },
  miniOccasionChipText: { fontSize: 9, fontWeight: '800', color: 'rgba(0,0,0,0.4)', textTransform: 'uppercase' },
  miniOccasionChipTextActive: { color: '#FFF' },
  wrongBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.04)',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    alignSelf: 'flex-start'
  },
  wrongBtnText: { color: 'rgba(0,0,0,0.6)', fontSize: 12, fontWeight: '600' },

  modalFooter: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    paddingHorizontal: 20,
    backgroundColor: Colors.surface,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(0,0,0,0.05)'
  },
  footerRow: { flexDirection: 'row', gap: 12 },
  addMoreBtn: {
    flex: 1,
    height: 56,
    backgroundColor: Colors.surfaceAlt,
    borderRadius: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6
  },
  addMoreBtnText: { color: '#000', fontSize: 16, fontWeight: '700' },
  confirmBtn: {
    flex: 1,
    height: 56,
    backgroundColor: Colors.surfaceAlt,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.08)'
  },
  confirmBtnText: { color: '#000', fontSize: 16, fontWeight: '700' },

  // Edit Modal Styles
  editBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center' },
  editContainer: { padding: 24 },
  editCard: { backgroundColor: Colors.surface, borderRadius: 24, padding: 24, borderWidth: 1, borderColor: 'rgba(0,0,0,0.08)' },
  editTitle: { fontSize: 22, fontWeight: '800', color: '#000', marginBottom: 20 },
  editLabel: { color: 'rgba(0,0,0,0.5)', fontSize: 12, fontWeight: '700', textTransform: 'uppercase', marginBottom: 8 },
  editInput: { backgroundColor: Colors.surfaceAlt, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14, color: '#000', fontSize: 16, marginBottom: 16, borderWidth: 1, borderColor: 'rgba(0,0,0,0.08)' },
  editActions: { flexDirection: 'row', gap: 12, marginTop: 8 },
  editCancelBtn: { flex: 1, height: 50, borderRadius: 25, backgroundColor: 'rgba(0,0,0,0.04)', alignItems: 'center', justifyContent: 'center' },
  editCancelText: { color: '#000', fontSize: 15, fontWeight: '600' },
  editSaveBtn: { flex: 1, height: 50, borderRadius: 25, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  editSaveText: { color: '#FFF', fontSize: 15, fontWeight: '700' },

  closetGrid: { flexDirection: 'row', gap: 10, justifyContent: 'space-between', marginBottom: 24 },
  closetSlot: { flex: 1, aspectRatio: 0.8, backgroundColor: Colors.surfaceAlt, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)', overflow: 'hidden' },
  slotPlaceholder: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  slotImg: { flex: 1, resizeMode: 'cover' },
  slotBadge: { position: 'absolute', bottom: 6, left: 6, right: 6, backgroundColor: 'rgba(0,0,0,0.6)', paddingVertical: 4, borderRadius: 8, alignItems: 'center' },
  slotBadgeText: { color: '#FFF', fontSize: 9, fontWeight: '700', textTransform: 'uppercase' }, // overlay on camera/image feed, keep dark
  uploadBox: { gap: 12, marginBottom: 20 },
  uploadBtnMain: { height: 64, backgroundColor: Colors.surface, borderRadius: 32, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12 },
  uploadBtnTextMain: { color: '#000', fontSize: 17, fontWeight: '700' },
  uploadBtnSec: { height: 60, backgroundColor: Colors.surfaceAlt, borderRadius: 32, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, borderWidth: 1, borderColor: 'rgba(0,0,0,0.08)' },
  uploadBtnTextSec: { color: '#000', fontSize: 16, fontWeight: '600' },
  miniSkip: { alignSelf: 'center', padding: 15, marginTop: 10 },
  miniSkipText: { color: 'rgba(0,0,0,0.2)', fontSize: 13, textDecorationLine: 'underline' },
  controlBar: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: 20, backgroundColor: Colors.bg },
  nextAction: { backgroundColor: '#000', height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center' },
  nextActionText: { fontSize: 16, fontWeight: '700', color: '#FFF' },
  heroAnalyze: { height: 110, borderRadius: 24, overflow: 'hidden', marginBottom: 12, borderWidth: 1, borderColor: 'rgba(0,0,0,0.08)' },
  heroInner: { flex: 1, padding: 16, justifyContent: 'center' },
  heroIconBox: { width: 44, height: 44, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.06)', alignItems: 'center', justifyContent: 'center' },
  heroTitle: { fontSize: 18, fontWeight: '800', color: '#000', letterSpacing: -0.4 },
  heroDesc: { fontSize: 12, color: 'rgba(0,0,0,0.4)', marginTop: 2, lineHeight: 15 },
  heroSummary: { marginTop: 8, backgroundColor: 'rgba(0,0,0,0.06)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, alignSelf: 'flex-start' },
  heroSummaryText: { color: '#000', fontSize: 10, fontWeight: '600' },
  fullScreenBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', justifyContent: 'center', alignItems: 'center' },
  fullScreenImg: { width: '100%', height: '80%' },
  fullScreenClose: { position: 'absolute', top: 50, right: 24, zIndex: 10, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center' },
});
