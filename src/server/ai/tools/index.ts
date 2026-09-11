import { ToolRegistry, type AnyTool } from './registry';
import {
  searchVehicles, getVehicle, getVehiclePowertrains, getVehicleTrims,
  getVehicleColours, calculateVehiclePrice, checkInventory,
} from './read/catalogue-tools';
import {
  getVehicleOptions, compareVehicles, calculateFinanceEstimateTool,
  getDealershipInformation, getDealershipHours, getVehicleFeatures,
} from './read/advice-tools';
import { getAvailableTestDriveSlots_tool } from './read/booking-tools';
import { createTestDriveTool } from './write/create-test-drive';
import { cancelTestDriveTool } from './write/cancel';
import {
  createCallbackRequest, createSupportTicket, createTradeInRequest,
  createFinancingRequestTool, requestHumanHandoff,
} from './write/requests';
import { saveBuild, updateContactPreferences } from './write/build';

/**
 * Everything the assistant can do. Nothing outside this list is reachable from
 * a conversation.
 *
 * Tools deliberately absent, each because it would breach a rule stated
 * elsewhere in the specification (see docs/03-ai-tools.md):
 *
 *   getCustomerProfile(email)  — customer-data enumeration behind a chatbot
 *   sendConfirmationEmail()    — email is a consequence of a committed
 *                                transaction, not a thing the model chooses
 *   updateLead(priority)       — priority is computed; status belongs to staff
 *   any inventory status write — only inventory.status.write holders move a car
 *   anything destructive       — nothing the assistant touches deletes
 */
export const TOOLS: AnyTool[] = [
  // Catalogue
  searchVehicles,
  getVehicle,
  getVehiclePowertrains,
  getVehicleTrims,
  getVehicleColours,
  getVehicleOptions,
  getVehicleFeatures,
  calculateVehiclePrice,
  compareVehicles,
  checkInventory,

  // Advice
  calculateFinanceEstimateTool,
  getDealershipInformation,
  getDealershipHours,
  getAvailableTestDriveSlots_tool,

  // Actions
  updateContactPreferences,
  saveBuild,
  createTestDriveTool,
  cancelTestDriveTool,
  createCallbackRequest,
  createSupportTicket,
  createTradeInRequest,
  createFinancingRequestTool,
  requestHumanHandoff,
];

let cached: ToolRegistry | undefined;

export function toolRegistry(): ToolRegistry {
  cached ??= new ToolRegistry(TOOLS);
  return cached;
}

export { ToolRegistry } from './registry';
export type { ToolContext, ToolDefinition } from './define';
