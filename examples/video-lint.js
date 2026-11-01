// 视频工程的校验器示例：在每次提交前运行，返回错误数组则整次修改回滚。
// 用法：jsondom run project.json edit.js --lint examples/video-lint.js

const MAX_CHARS = { 'caption-band': 14, 'price-band': 10 };

export default function videoLint({ doc, touched }) {
  const errors = [];
  const zones = doc.root.zones || {};
  // 只检查本次改动涉及的元素及其子元素，保持快速
  const scope = doc.$(touched).add(doc.$(touched).find('*'));
  for (const n of scope) {
    const where = `#${n.id ?? doc.pointer(n)}`;
    if (n.zone !== undefined && !zones[n.zone]) errors.push({ path: doc.pointer(n), message: `${where} 引用了不存在的版面区域 "${n.zone}"` });
    if (typeof n.start === 'number' && typeof n.duration === 'number' && n.duration <= 0)
      errors.push({ path: doc.pointer(n), message: `${where} 时长必须大于 0` });
    if (n.type === 'text' && MAX_CHARS[n.zone] && String(n.text ?? '').length > MAX_CHARS[n.zone])
      errors.push({ path: doc.pointer(n), message: `${where} 文案 ${String(n.text).length} 字，超过 ${n.zone} 的上限 ${MAX_CHARS[n.zone]} 字` });
  }
  // 同一区域的文字在时间上不能重叠
  const texts = doc.$('text[zone]').toArray().sort((a, b) => a.start - b.start);
  for (let i = 1; i < texts.length; i++) {
    const a = texts[i - 1];
    const b = texts[i];
    if (a.zone === b.zone && a.start + a.duration > b.start + 1e-6)
      errors.push({ path: doc.pointer(b), message: `#${b.id} 与 #${a.id} 在 ${a.zone} 区域时间重叠` });
  }
  return errors;
}
