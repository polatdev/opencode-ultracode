export const meta = {
  name: 'new-ai-models-research',
  description: 'Yeni çıkan AI modellerini web araştırmayla tarar ve tek raporda birleştirir (hızlı tarama)',
  phases: [
    { title: 'Tarama', detail: '4 paralel araştırma ajanı (lab/scope başına)' },
    { title: 'Sentez', detail: 'tüm bulguları tek Türkçe raporda birleştir' },
  ],
}

const asOf = args?.date ?? '2026-09-16'

const schema = {
  type: 'object',
  properties: {
    lab: { type: 'string', description: 'Araştırılan lab veya scope' },
    models: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          releaseDate: { type: 'string', description: 'YYYY-MM (bilinmiyorsa tahmine en yakın)' },
          highlights: { type: 'string', description: '2-3 cümle: yetenek, fiyatlandırma, erişim' },
          sources: { type: 'array', items: { type: 'string' }, description: 'Kaynak URL listesi' },
        },
        required: ['name', 'highlights'],
      },
    },
    notes: { type: 'string', description: 'Şüpheli belirsiz bilgiler, sınırlamalar, eksikler' },
  },
  required: ['lab', 'models'],
}

function researcher(lab, focus) {
  return () =>
    agent(
      `Web araştırması görevi. Bugünün tarihi: ${asOf}. Konu: ${lab} — ${focus}.

Sadece son ~6 ayda (Mart 2026 - ${asOf} arası) duyurulan veya kullanıma açılan modelleri listele.
web_search ve web_fetch / mcp web araçlarını kullan. Kaynak olarak resmi blog/günlük sayfalarını ve büyük teknoloji haber sitelerini tercih et; her model için en az 1 kaynak URL ver.

Her model için topla: ad, yayın tarihi (YYYY-MM), 2-3 cümlelik özet (ana yetenek, fiyatlandırma/ erişim durumu).
Uydurma model uydurma; emin olamadığın bir şeyi "notes" alanına şüphe olarak yaz. Eski (Mart 2026 öncesi) modelleri YOK say.`,
      { label: `research:${lab}`, phase: 'Tarama', schema }
    )
}

phase('Tarama')
log(`Hızlı tarama başlıyor, referans tarih: ${asOf}`)

const findings = (
  await parallel([
    researcher('openai', 'OpenAI — GPT-5 serisi ve sonrası, o3 ailesinin güncellemeleri, imaj/ses/video modelleri (Sora vb.)'),
    researcher('anthropic+google', 'Anthropic Claude ve Google Gemini — 2026 ilk yarısında çıkan yeni sürümler'),
    researcher('xai+mistral+meta', 'xAI Grok, Mistral, Meta Llama — 2026 ilk yarısında çıkan yeni modeller'),
    researcher('deepseek+qwen+open', 'DeepSeek, Alibaba Qwen ve diğer Çin labları + açık ağırlıklı modeller; genel benchmark karşılaştırmaları ve fiyat trendleri'),
  ])
).filter(Boolean)

if (findings.length === 0) {
  log('Tarama sonuçsuz kaldı — sentez atlanıyor')
  return 'HİÇBİR araştırma ajanı sonuç üretmedi (hepsi null). Workflow tekrar çalıştırılmalı.'
}

log(`${findings.length}/4 araştırma tamamlandı, sentez başlıyor`)

phase('Sentez')
const report = await agent(
  `Aşağıda ${asOf} tarihi itibarıyla yeni çıkan AI modelleri hakkında 4 araştırmacının yapılandırılmış bulguları var (JSON).
Bunları tek, tutarlı, Türkçe bir raporda birleştir. Rapor yapısı:

1) ÖZET — 5 maddede en önemli gelişmeler
2) LAB BAZINDA MODELLER — tablo: Model | Tarih | Öne çıkan özellik | Kaynak (URL)
3) TRENDLER VE ÇIKARIMLAR — fiyatlandırma, açık ağırlıklı modellerin yükselişi, yetenek sıçramaları vb.
4) KAYNAKLAR — bulgularda geçen tüm URL listesi

Kurallar: bulgular çelişirse çelişkiyi açıkça belirt; uydurma model veya kaynak EKLEME; yalnızca verilen JSON'daki bilgiyi kullan. Raporu düz metin olarak (markdown) döndür.

BULGULAR:
${JSON.stringify(findings, null, 2)}`,
  { label: 'sentez', phase: 'Sentez' }
)

if (!report) {
  return 'Sentez ajanı sonuç üretmedi. Araştırma bulguları mevcut ancak rapor yazılamadı.'
}
return report
