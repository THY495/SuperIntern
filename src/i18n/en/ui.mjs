// 英文目录：看板里按上下文区分的短词（Tc('上下文', '原文')，键是"上下文|原文"）。
// 同一个中文放在不同位置意思不同：只有一张表时只能给一种英文，所以按上下文另起一条。
export default {
  'role|成员': 'Member',
  'file|新增': 'added',
  'file|删除': 'deleted',
  'file|改名': 'renamed',
  'task|已恢复': 'Resumed',
  'activity|继续': 'Resumed',
  'field|上限': 'Limit',
  'dtype|交付': 'Delivery',   // 决策类型名（按钮上的"交付"仍是 Deliver）
  // 看板代码里拼接用的中文破折号（"模板名 —— 说明"）
  ' —— ': ' — ',
  // 主机名列表的分隔（中文用全角空格）
  '　': ', ',
};
