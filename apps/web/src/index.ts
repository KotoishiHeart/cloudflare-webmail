import { handleWebRequest } from './app.js';

export default {
  fetch(request: Request): Response {
    return handleWebRequest(request);
  },
} satisfies ExportedHandler<Env>;
