import streamDeck, { LogLevel } from "@elgato/streamdeck";
import { WledAction } from "./actions/wled-action.js";

// Enable logging
streamDeck.logger.setLevel(LogLevel.INFO);

// Register action
streamDeck.actions.registerAction(new WledAction());

// Connect
streamDeck.connect();