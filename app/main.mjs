import { main,setDashboardExtension,releaseLock } from './engine.mjs';
import { createPanelExtension } from './panel.mjs';
setDashboardExtension(createPanelExtension);
main().catch(error=>{releaseLock();console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
