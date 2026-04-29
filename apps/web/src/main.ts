import { Button, color, FocusManager, Panel, spacing, typography } from "@durak/ui";
import { Application, Container, Text } from "pixi.js";

const mountId = "app";
const mount = document.getElementById(mountId);
if (!mount) throw new Error(`#${mountId} not found in index.html`);

const app = new Application();
await app.init({
  background: color.bg,
  resizeTo: mount,
  antialias: false,
  autoDensity: true,
  resolution: window.devicePixelRatio || 1,
});
mount.appendChild(app.canvas);

const screen = new Container();
app.stage.addChild(screen);

const focus = new FocusManager();
focus.attach();

const panelW = 480;
const panelH = 280;
const panel = new Panel({ width: panelW, height: panelH });
screen.addChild(panel);

const title = new Text({
  text: "HELLO DURAK",
  style: {
    fontFamily: typography.family,
    fontSize: typography.size.xxl,
    fontWeight: typography.weight.bold,
    fill: color.text,
    letterSpacing: typography.letterSpacing.stamp,
  },
});
title.x = Math.round((panelW - title.width) / 2);
title.y = spacing.xl;
panel.addChild(title);

const hint = new Text({
  text: "ARROWS / TAB MOVE  -  ENTER ACTIVATES",
  style: {
    fontFamily: typography.family,
    fontSize: typography.size.xs,
    fill: color.textMuted,
    letterSpacing: typography.letterSpacing.wide,
  },
});
hint.x = Math.round((panelW - hint.width) / 2);
hint.y = spacing.xl + title.height + spacing.sm;
panel.addChild(hint);

const status = new Text({
  text: "",
  style: {
    fontFamily: typography.family,
    fontSize: typography.size.sm,
    fill: color.accent,
    letterSpacing: typography.letterSpacing.wide,
  },
});
panel.addChild(status);

const buttonW = 220;
const buttonH = 56;
let clicks = 0;
const button = new Button({
  label: "PRESS START",
  width: buttonW,
  height: buttonH,
  onActivate: () => {
    clicks += 1;
    status.text = `STAMPED x${clicks}`;
    status.x = Math.round((panelW - status.width) / 2);
  },
});
button.x = Math.round((panelW - buttonW) / 2);
button.y = panelH - spacing.xl - buttonH;
panel.addChild(button);
focus.register(button);

status.x = Math.round((panelW - status.width) / 2);
status.y = button.y + buttonH + spacing.sm;

const layout = (): void => {
  panel.x = Math.round((app.screen.width - panelW) / 2);
  panel.y = Math.round((app.screen.height - panelH) / 2);
};
layout();
app.renderer.on("resize", layout);
