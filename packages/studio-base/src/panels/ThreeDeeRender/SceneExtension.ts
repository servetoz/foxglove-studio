// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { set, unset } from "lodash";
import * as THREE from "three";
import { DeepPartial } from "ts-essentials";

import { MessageEvent, SettingsTreeAction } from "@foxglove/studio";

import { Path } from "./LayerErrors";
import { BaseUserData, Renderable } from "./Renderable";
import type { Renderer } from "./Renderer";
import type { SettingsTreeEntry } from "./SettingsManager";
import { missingTransformMessage, MISSING_TRANSFORM } from "./renderables/transforms";
import { AnyFrameId } from "./transforms";
import { updatePose } from "./updatePose";

export type PartialMessage<T> = DeepPartial<T>;

export type PartialMessageEvent<T> = MessageEvent<DeepPartial<T>>;

/**
 * SceneExtension is a base class for extending the 3D scene. It extends THREE.Object3D and is a
 * child of the THREE.Scene with an identity position and orientation (origin is the render frame
 * origin). The `startFrame()` method will automatically call `updatePose()` for each Renderable in
 * the `renderables` map, placing it at the correct pose given the current renderer TransformTree.
 *
 * A minimum implementation can simply add THREE.Object3D instances using `this.add()`. If these
 * instances are Renderables and also added to this.renderables, their pose will be kept
 * up-to-date in `startFrame()`.
 *
 * - Override `dispose()` to dispose of any unmanaged resources such as GPU buffers. Don't forget
 *   to call `super.dispose()`.
 * - Override `startFrame()` to execute code at the start of each frame. Call `super.startFrame()`
 *   to run `updatePose()` on each entry in `this.renderables`.
 * - Override `settingsNodes()` to add entries to the settings sidebar.
 * - Message subscriptions are added with `renderer.addDatatypeSubscriptions()` or
 *   `renderer.addTopicSubscription()`.
 * - Custom layer actions are added with `renderer.addCustomLayerAction()`.
 */
export class SceneExtension<
  TRenderable extends Renderable<BaseUserData> = Renderable<BaseUserData>,
  E extends THREE.BaseEvent = THREE.Event,
> extends THREE.Object3D<E> {
  /** A unique identifier for this SceneExtension, such as `foxglove.Markers`. */
  public readonly extensionId: string;
  /** A reference to the parent `Renderer` instance. */
  protected readonly renderer: Renderer;
  /**
   * A map of string identifiers to Renderable instances. SceneExtensions are free to use any IDs
   * they choose, although topic names are a common choice for extensions display up to one
   * renderable per topic.
   */
  public readonly renderables = new Map<string, TRenderable>();

  /**
   * @param extensionId A unique identifier for this SceneExtension, such as `foxglove.Markers`.
   * @param renderer A reference to the parent `Renderer` instance.
   */
  public constructor(extensionId: string, renderer: Renderer) {
    super();
    this.extensionId = this.name = extensionId;
    this.renderer = renderer;
    // updateSettingsTree() will call settingsNodes() which may be overridden in a child class.
    // The child class may not assign its members until after this constructor returns. This breaks
    // type assumptions, so we need to defer the call to updateSettingsTree()
    queueMicrotask(() => this.updateSettingsTree());
  }

  /**
   * Called when the scene is being destroyed. Free any unmanaged resources such as GPU buffers
   * here. The base class implementation calls dispose() on all `renderables`.
   */
  public dispose(): void {
    for (const renderable of this.renderables.values()) {
      renderable.dispose();
    }
    this.children.length = 0;
    this.renderables.clear();
  }

  /**
   * Called when seeking or a new data source is loaded. The base class implementation removes all
   * `renderables` and calls `updateSettingsTree()`.
   */
  public removeAllRenderables(): void {
    for (const renderable of this.renderables.values()) {
      renderable.dispose();
      this.remove(renderable);
    }
    this.renderables.clear();
    this.updateSettingsTree();
  }

  /**
   * Returns a list of settings nodes generated by this extension and the paths they appear at in
   * the settings sidebar. This method is only called when the scene fundamentally changes such as
   * new topics appearing or seeking. To manually trigger this method being called, use
   * `updateSettingsTree()`. The base class implementation returns an empty list.
   */
  public settingsNodes(): SettingsTreeEntry[] {
    return [];
  }

  /**
   * Handler for settings tree updates such as visibility toggling or field edits. This is a stub
   * meant to be overridden in derived classes and used as the handler for settings tree nodes.
   */
  public handleSettingsAction = (action: SettingsTreeAction): void => {
    void action;
  };

  /**
   * Manually triggers an update of the settings tree for the nodes generated by this extension. The
   * `settingsNodes()` method will be called to retrieve the latest nodes.
   */
  public updateSettingsTree(): void {
    this.renderer.settings.setNodesForKey(this.extensionId, this.settingsNodes());
  }

  /**
   * Persists a value to the panel configuration at the given path. The base class implementation
   * calls `renderer.updateConfig()` and `updateSettingsTree()`.
   */
  public saveSetting(path: Path, value: unknown): void {
    // Update the configuration
    this.renderer.updateConfig((draft) => {
      if (value == undefined) {
        unset(draft, path);
      } else {
        set(draft, path, value);
      }
    });

    // Update the settings sidebar
    this.updateSettingsTree();
  }

  /**
   * Can be overridden to react to color scheme changes. The base class implementation does nothing.
   */
  public setColorScheme(
    colorScheme: "dark" | "light",
    backgroundColor: THREE.Color | undefined,
  ): void {
    void colorScheme;
    void backgroundColor;
  }

  /**
   * Called before the Renderer renders a new frame. The base class implementation calls
   * updatePose() for each entry in `this.renderables`.
   * @param currentTime Current time of the scene being rendered in nanoseconds. This is the
   *   playback timestamp not a message timestamp, so it only makes sense to compare it to
   *   `receiveTime` values.
   * @param renderFrameId Coordinate frame where the scene camera is currently located.
   * @param fixedFrameId The root coordinate frame of the scene, called the fixed frame because it
   *   does not move relative to any parent frame. The fixed frame is the root frame of the render
   *   frame.
   */
  public startFrame(
    currentTime: bigint,
    renderFrameId: AnyFrameId,
    fixedFrameId: AnyFrameId,
  ): void {
    for (const renderable of this.renderables.values()) {
      const path = renderable.userData.settingsPath;

      // Update the THREE.Object3D.visible flag from the user settings visible toggle. If this
      // renderable is not visible, clear any layer errors and skip its per-frame update logic
      renderable.visible = renderable.userData.settings.visible;
      if (!renderable.visible) {
        this.renderer.settings.errors.clearPath(path);
        continue;
      }

      // SceneExtension Renderables exist in a coordinate frame (`frameId`) at some position and
      // orientation (`pose`) at a point in time (`messageTime` if `frameLocked` is false, otherwise
      // `currentTime`). The scene is rendered from the point of view of another coordinate frame
      // (`renderFrameId`) that is part of a coordinate frame hierarchy with `fixedFrameId` at its
      // root (`renderFrameId` can be equal to `fixedFrameId`). The fixed is assumed to be the
      // static world coordinates that all other frames connect to.
      //
      // Before each visual frame is rendered, every Renderable is transformed from its own
      // coordinate frame (at its own `messageTime` when `frameLocked` is false) to the fixed frame
      // at `currentTime` and then to the render frame at `currentTime`. This transformation is
      // done using transform interpolation, so as new transform messages are received the results
      // of this interpolation can change from frame to frame
      const frameLocked = renderable.userData.settings.frameLocked ?? true;
      const srcTime = frameLocked ? currentTime : renderable.userData.messageTime;
      const frameId = renderable.userData.frameId;
      const updated = updatePose(
        renderable,
        this.renderer.transformTree,
        renderFrameId,
        fixedFrameId,
        frameId,
        currentTime,
        srcTime,
      );
      if (!updated) {
        const message = missingTransformMessage(renderFrameId, fixedFrameId, frameId);
        this.renderer.settings.errors.add(path, MISSING_TRANSFORM, message);
      } else {
        this.renderer.settings.errors.remove(path, MISSING_TRANSFORM);
      }
    }
  }
}
