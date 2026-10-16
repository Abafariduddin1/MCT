import type {CoreModules} from './types.js';
export async function loadCore():Promise<CoreModules>{
  // Compiled entry is backend/dist/src; the unchanged core stays at backend/core.
  const root=new URL('../../core/src/',import.meta.url);
  const [settings,chain,api]=await Promise.all([
    import(new URL('config.mjs',root).href),import(new URL('chain.mjs',root).href),import(new URL('api.mjs',root).href)
  ]) as [{config:CoreModules['config']},{Chain:CoreModules['Chain'];verifyRouteInstruction:CoreModules['verifyRouteInstruction']},{validateQuote:CoreModules['validateQuote']}];
  return{config:settings.config,Chain:chain.Chain,validateQuote:api.validateQuote,verifyRouteInstruction:chain.verifyRouteInstruction};
}
