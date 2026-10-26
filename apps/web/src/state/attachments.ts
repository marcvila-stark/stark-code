import { createAttachmentEnvironmentAtoms } from "@starkfuture/client-runtime/state/attachments";

import { connectionAtomRuntime } from "../connection/runtime";

export const attachmentEnvironment = createAttachmentEnvironmentAtoms(connectionAtomRuntime);
