import streamDeck from "@elgato/streamdeck";
import { WoWSlotAction } from "./actions/slot-action.js";

streamDeck.logger.setLevel("info");
streamDeck.actions.registerAction(new WoWSlotAction());
void streamDeck.connect();
