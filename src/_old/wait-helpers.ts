// import { expect, type Page } from "@playwright/test";
// import type { RimoriTestEnvironment } from "../core/RimoriTestEnvironment";
// import type { EventHandler } from "../types/event-bus";

// export async function waitForEvent(
//   environment: RimoriTestEnvironment,
//   topic: string,
//   timeout = 10000
// ): Promise<unknown> {
//   return new Promise((resolve, reject) => {
//     let timer: NodeJS.Timeout | undefined;
//     const handler: EventHandler = ({ data, event }) => {
//       if (event.topic !== topic) {
//         return;
//       }
//       if (timer) {
//         clearTimeout(timer);
//       }
//       environment.offEvent(topic, handler);
//       resolve(data);
//     };

//     timer = setTimeout(() => {
//       environment.offEvent(topic, handler);
//       reject(new Error(`Timed out waiting for event ${topic}`));
//     }, timeout);

//     environment.onEvent(topic, handler);
//   });
// }

