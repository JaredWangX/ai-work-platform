export const groups = [
  ['工作台', [['home','工作台','layout-dashboard'], ['chat','AI 对话','messages-square'], ['projects','项目协作','kanban'], ['tasks','定时任务','clock'], ['files','文件管理','folder']]],
  ['团队', [['staff','AI 员工','bot'], ['teams','专家团队','users-round'], ['users','用户管理','user-round-cog']]],
  ['资源', [['knowledge','知识库','book-open'], ['database','数据库','database'], ['skills','我的技能','wand-sparkles'], ['market','技能市场','store'], ['models','模型管理','boxes']]],
  ['设置', [['settings','个人设置','user-round'],['system','系统设置','settings']]],
];

export const seed = {
  profile:{name:'产品团队',theme:'light'},
  memoryEnabled:true,
  preferences:'经营周报使用简体中文。先列结论，再给渠道明细和需要跟进的问题。每项跟进注明负责人。',
  tools:[
    {id:'mcp1',name:'团队资料检索',description:'Streamable HTTP · 案例配置',url:'https://knowledge.example/mcp'},
    {id:'mcp2',name:'经营数据查询',description:'Streamable HTTP · 案例配置',url:'https://analytics.example/mcp'},
  ],
  invites:[
    {id:'invite1',code:'DEMO-A1',note:'产品团队',status:'未使用'},
    {id:'invite2',code:'DEMO-B2',note:'运营组',status:'已使用'},
  ],
  chats:[],
  projects: [
    {id:'p1',name:'检查渠道发布素材',owner:'运营同事',description:'核对渠道中的产品描述、图片和下载入口。把需要调整的地方记录在发布清单里，更新后请产品同事复核。',status:'进行中',due:'11/20',file:'case-launch',comments:[{author:'产品同事',text:'请重点检查手机端的介绍图片，保持功能名称一致。'},{author:'运营同事',text:'已更新两处图片，下载入口也已核对，正在补充清单。'}]},
    {id:'p2',name:'汇总首批用户反馈',owner:'客服同事',description:'按使用场景归类，保留原始反馈、来源和发生时间。',status:'待开始',due:'11/22'},
    {id:'p3',name:'整理发布方案',owner:'文档撰写助手',description:'方案与分工表已保存到项目文件。',status:'已完成',file:'case-launch'},
    {id:'p4',name:'更新常见问题',owner:'产品同事',description:'根据反馈补充说明和操作步骤。标注已核对的内容和仍存在的问题。',status:'待开始',due:'11/22'},
    {id:'p5',name:'核对发布清单',owner:'文档撰写助手',description:'确认负责人、时间与交付文件。记录每项完成标准和证明材料。',status:'进行中',due:'11/20'},
    {id:'p6',name:'确认产品介绍',owner:'产品同事',description:'团队已核对产品功能和使用范围。',status:'已完成'},
  ],
  tasks: [
    {id:'t1',name:'每日经营数据摘要',description:'分析昨日营收、订单量和商品退款率。写一日总结，列出主要变化和需要跟进的问题。',assignee:'s1',tag:'经营分析',time:'08:30',frequency:'每天',enabled:true,runs:[
      {at:'11/19 08:30',seconds:42,status:'success',text:'昨日经营摘要\n营收 ¥86,420，较前一日增长 8.6%，完成订单 1,274 单，客单价 ¥67.83。\n\n主要发现\n官网与平台渠道贡献主要营收，两款商品退款率高于近七日均值。\n\n建议关注\n先核对退款订单的商品与渠道分布。已记录订单筛选范围与跟进负责人。',logs:['读取昨日经营汇总','核对营收、订单和退款口径','生成经营摘要']},
      {at:'11/18 08:30',seconds:38,status:'success',text:'复购订单贡献了主要增量。将官网与平台渠道分开核对，后续跟进客单价变化。',logs:['读取渠道订单','汇总经营变化']},
      {at:'11/17 08:30',seconds:12,status:'failed',text:'示例输入缺少退款明细，无法计算退款率。补齐渠道数据后可重新执行。',logs:['读取渠道订单','退款明细缺失']},
      {at:'11/16 08:30',seconds:45,status:'success',text:'汇总营收、订单与退款，记录核对口径。没有发现需要立即处理的渠道异常。',logs:['读取渠道订单','保存经营摘要']},
    ]},
    {id:'t2',name:'竞品动态整理',description:'按产品更新、渠道活动和价格变化归类，区分已核实记录与待核实线索。',assignee:'s2',tag:'内容运营',time:'10:00',frequency:'每个工作日',enabled:true,runs:[]},
    {id:'t3',name:'每周内容选题',description:'汇总客户常问问题和行业信息，整理三条内容选题，并为每条添加来源及读者需求。',assignee:'s3',tag:'内容运营',time:'09:30',frequency:'每周一',enabled:true,runs:[{at:'11/18 09:30',seconds:26,status:'success',text:'已整理产品使用指南、客户常见问题和服务权益解读三个选题。产品组负责核对功能描述，运营组安排发布。'}]},
    {id:'t4',name:'订单数据归档',description:'检查订单字段后形成归档清单，列出时间范围、渠道、缺失字段和负责人。',tag:'数据处理',time:'23:00',frequency:'每天',enabled:false,runs:[{at:'11/18 23:00',seconds:15,status:'success',text:'已整理本日订单清单，抽查重复订单与退款状态。待补齐两条渠道备注。'}]},
  ],
  staff:[
    {id:'s1',name:'经营分析助手',description:'分析渠道经营数据，生成周报并追踪异常。',specialty:'经营分析',skills:['sk1','sk2'],vault:true,database:'db1'},
    {id:'s2',name:'行业研究助手',description:'整理行业资料，核对来源与关联笔记。',specialty:'资料核对',skills:['sk2'],vault:true},
    {id:'s3',name:'文档撰写助手',description:'整理方案、分工表与交付文档。',specialty:'文档排版',skills:['sk3']},
  ],
  teams:[{id:'g1',name:'行业研究小组',description:'围绕新能源市场整理资料、核对数字和形成简报。',specialty:'资料与分析',members:['s2','s1','s3'],file:'case-research'}, {id:'g2',name:'经营分析小组',description:'处理渠道周报、趋势分析与退款核对。',specialty:'周报与数据',members:['s1','s2'],file:'case-weekly-doc'}, {id:'g3',name:'内容发布小组',description:'整理新品发布分工、渠道素材与客户问题。',specialty:'文案与排版',members:['s3','s1'],file:'case-launch'}],
  users:[{id:'u1',name:'运营负责人',description:'operations',specialty:'管理员'},{id:'u2',name:'产品同事',description:'product',specialty:'成员'}],
  knowledge:[
    {id:'k1',name:'新能源市场总览',description:'行业研究',body:'研究目标\n梳理新能源市场中可能影响用户购车决策的因素，优先查充电便利性、车价和服务覆盖范围。\n\n资料范围\n把材料分为政策、基础设施和竞品三部分。每条公开数据都保留原始出处、统计周期和适用城市。\n\n待核实\n先对齐各城市充电设施的统计口径，再讨论不同城市的使用便利性。',related:'k2'},
    {id:'k2',name:'充电桩基础设施',description:'行业研究',body:'数据记录\n给每条数据补齐统计时间、地理范围、数据来源和设备类型。公开充电设施和私人充电设施分开比较。\n\n后续采集\n查找各城市公开设施分布，优先补齐居住区、通勤半径和高速服务区三个使用场景。',related:'k1'},
    {id:'k3',name:'竞品对标总表',description:'竞品分析',body:'比较维度\n价格以同版本公开报价为基准，单列限时优惠。服务范围记录覆盖城市、权益使用条件和有效期。\n\n核对规则\n每项结论标注出处和日期。缺少价格或服务口径的品牌暂不参与排名，提交前对照原文复核。',related:'k1'},
    {id:'k4',name:'渠道订单与退款口径',description:'经营分析',related:'k5',body:'统计规则\n以支付订单作为退款率分母。同一订单的重复退款合并计数。\n\n核对流程\n只比较相同统计周期的渠道数据。企业与平台回传晚于日结时，先记录差异，复核后补录。'},
    {id:'k5',name:'经营周报模板',description:'经营分析',related:'k4',body:'交付顺序\n先写本周总体变化，再列出各渠道数据、需要核对的异常和跟进分工。\n\n复核清单\n每个同比或环比数字注明时间范围。列清已确认、待核实和计划中的事项。'},
    {id:'k6',name:'新品发布准备',description:'产品',body:'上线检查\n先检查产品页的功能、价格、图片与下载入口。同一素材在移动端与桌面端都需要验证。\n\n协作记录\n上线时记录验证人、入口状态和异常的跟进人。'},
    {id:'k7',name:'客户反馈记录规范',description:'产品',related:'k6',body:'记录信息\n保留用户原话、反馈场景、发生时间和来源。复现步骤统一写在备注中。\n\n归类方式\n区分核心功能、使用说明、售后和新增需求。先解决无法完成的核心任务。'},
  ],
  database:[
    {id:'db1',name:'渠道经营数据',description:'订单、销售与退款明细',engine:'SQLite · 只读',source:'sales',database:'orders'},
    {id:'db2',name:'客户服务数据',description:'客户反馈与回访记录',engine:'SQLite · 只读',source:'service',database:'tickets'},
  ],
  skills:[
    {id:'sk1',name:'经营周报',description:'按渠道整理销售额、订单与退款率，输出结论与待办。',specialty:'写作',version:'1.0.0',instructions:'对齐统计周期与渠道口径。先写总量和变化，再列出异常、证据和负责人。待核实的原因另列，保留原始数据出处。'},
    {id:'sk2',name:'资料核对',description:'归类资料，列出需要回查原文的数字。',specialty:'研究',instructions:'按来源、时间、地区记下每条资料。区分原文事实与待验证结论。数字必须标注统计口径。'},
    {id:'sk3',name:'文档排版',description:'统一报告、分工计划和清单的结构。',specialty:'写作',instructions:'先给结论与适用范围。把需要比较的内容放入表格，待办注明负责人和截止日期。'},
  ],
  market:[
    {id:'meeting',name:'会议纪要',description:'整理会上结论、负责人和待办事项。',specialty:'团队协作'},
    {id:'sheet',name:'表格校验',description:'检查必填字段、重复记录和数据格式。',specialty:'数据处理'},
    {id:'format',name:'文档排版',description:'统一报告标题、清单和表格格式。',specialty:'写作'},
  ],
  files:[],
};
