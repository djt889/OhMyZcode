/**
 * adapters/zcode/index.mjs
 * ZCode 宿主适配层统一入口：路径/编码卫生、能力探测、profile 降级、worker transport 状态机、
 * boulder 槽位（跨会话指针，B32）。
 */
export * from './path.mjs';
export * from './capability.mjs';
export * from './fallback.mjs';
export * from './transport.mjs';
export * from './boulder.mjs';
