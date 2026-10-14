// 请求级的审计上下文：服务账户替人做事时，这次请求里写下的每一行审计都带上 on_behalf_of ——
// 不用把它一层层传进每个函数（写审计的地方有几百处）。没在 runAs 里的调用一律是 null。

import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

/** 在 fn（及其异步续体）里，审计行的 on_behalf_of = onBehalfOf。 */
export const runAs = ({ onBehalfOf = null } = {}, fn) => als.run({ onBehalfOf }, fn);

export const currentOnBehalfOf = () => als.getStore()?.onBehalfOf ?? null;
