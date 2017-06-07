/*
 * Copyright (C) 2017 TypeFox and others.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { injectable, inject, optional } from "inversify"
import { ComputedBoundsAction, RequestBoundsAction } from '../features/bounds/bounds-manipulation'
import { Bounds } from "../utils/geometry"
import { Match, applyMatches } from "../features/update/model-matching"
import { UpdateModelAction, UpdateModelCommand } from "../features/update/update-model"
import { Action, ActionHandlerRegistry } from "../base/intent/actions"
import { IActionDispatcher } from "../base/intent/action-dispatcher"
import { RequestModelAction, SetModelAction } from "../base/features/model-manipulation"
import { SModelElementSchema, SModelIndex, SModelRootSchema } from "../base/model/smodel"
import { ModelSource } from "../base/model/model-source"
import { findElement } from "../base/model/smodel-utils"
import { RequestPopupModelAction, SetPopupModelAction } from "../features/hover/hover"
import { ViewerOptions } from "../base/view/options"
import { TYPES } from "../base/types"

export type LayoutEngine = (root: SModelRootSchema) => void

export type PopupModelFactory = (request: RequestPopupModelAction, element?: SModelElementSchema)
    => SModelRootSchema | undefined

/**
 * A model source that handles actions for bounds calculation and model
 * updates.
 */
@injectable()
export class LocalModelSource extends ModelSource {

    protected currentRoot: SModelRootSchema = {
        type: 'NONE',
        id: 'ROOT'
    }

    get model(): SModelRootSchema {
        return this.currentRoot
    }

    set model(root: SModelRootSchema) {
        this.setModel(root)
    }

    protected onModelSubmitted: (newRoot: SModelRootSchema) => void

    constructor(@inject(TYPES.IActionDispatcher) actionDispatcher: IActionDispatcher,
                @inject(TYPES.ActionHandlerRegistry) actionHandlerRegistry: ActionHandlerRegistry,
                @inject(TYPES.ViewerOptions) viewerOptions: ViewerOptions,
                @inject(TYPES.LayoutEngine)@optional() protected layoutEngine?: LayoutEngine,
                @inject(TYPES.PopupModelFactory)@optional() protected popupModelFactory?: PopupModelFactory) {
        super(actionDispatcher, actionHandlerRegistry, viewerOptions)
    }

    protected initialize(registry: ActionHandlerRegistry): void {
        super.initialize(registry)

        // Register model manipulation commands
        registry.registerCommand(UpdateModelCommand)

        // Register this model source
        registry.register(ComputedBoundsAction.KIND, this)
        registry.register(RequestPopupModelAction.KIND, this)
    }

    setModel(newRoot: SModelRootSchema): void {
        this.currentRoot = newRoot
        this.submitModel(newRoot, false)
    }

    updateModel(newRoot?: SModelRootSchema): void {
        if (newRoot === undefined) {
            this.submitModel(this.currentRoot, true)
        } else {
            this.currentRoot = newRoot
            this.submitModel(newRoot, true)
        }
    }

    protected submitModel(newRoot: SModelRootSchema, update: boolean): void {
        if (this.viewerOptions.needsClientLayout) {
            this.actionDispatcher.dispatch(new RequestBoundsAction(newRoot))
        } else {
            if (this.layoutEngine !== undefined) {
                this.layoutEngine(newRoot)
            }
            if (update) {
                this.actionDispatcher.dispatch(new UpdateModelAction(newRoot))
            } else {
                this.actionDispatcher.dispatch(new SetModelAction(newRoot))
            }
            if (this.onModelSubmitted !== undefined) {
                this.onModelSubmitted(newRoot)
            }
        }
    }

    applyMatches(matches: Match[]): void {
        const root = this.currentRoot
        applyMatches(root, matches)
        if (this.viewerOptions.needsClientLayout) {
            this.actionDispatcher.dispatch(new RequestBoundsAction(root))
        } else {
            if (this.layoutEngine !== undefined) {
                this.layoutEngine(root)
            }
            const update = new UpdateModelAction()
            update.matches = matches
            this.actionDispatcher.dispatch(update)
            if (this.onModelSubmitted !== undefined) {
                this.onModelSubmitted(root)
            }
        }
    }

    addElements(elements: (SModelElementSchema | { element: SModelElementSchema, parentId: string })[]): void {
        const matches: Match[] = []
        for (const i in elements) {
            const e: any = elements[i]
            if (e.element !== undefined && e.parentId !== undefined) {
                matches.push({
                    right: e.element,
                    rightParentId: e.parentId
                })
            } else if (e.id !== undefined) {
                matches.push({
                    right: e,
                    rightParentId: this.currentRoot.id
                })
            }
        }
        this.applyMatches(matches)
    }

    removeElements(elements: (string | { elementId: string, parentId: string })[]) {
        const matches: Match[] = []
        const index = new SModelIndex()
        index.add(this.currentRoot)
        for (const i in elements) {
            const e: any = elements[i]
            if (e.elementId !== undefined && e.parentId !== undefined) {
                const element = index.getById(e.elementId)
                if (element !== undefined) {
                    matches.push({
                        left: element,
                        leftParentId: e.parentId
                    })
                }
            } else {
                const element = index.getById(e)
                if (element !== undefined) {
                    matches.push({
                        left: element,
                        leftParentId: this.currentRoot.id
                    })
                }
            }
        }
        this.applyMatches(matches)
    }

    handle(action: Action): void {
        switch (action.kind) {
            case RequestModelAction.KIND:
                this.handleRequestModel(action as RequestModelAction)
                break
            case ComputedBoundsAction.KIND:
                this.handleComputedBounds(action as ComputedBoundsAction)
                break
            case RequestPopupModelAction.KIND:
                this.handleRequestPopupModel(action as RequestPopupModelAction)
                break
        }
    }

    protected handleRequestModel(action: RequestModelAction): void {
        this.submitModel(this.currentRoot, false)
    }

    protected handleComputedBounds(action: ComputedBoundsAction): void {
        const root = this.currentRoot
        const index = new SModelIndex()
        index.add(root)
        for (const b of action.bounds) {
            const element = index.getById(b.elementId)
            if (element !== undefined)
                this.applyBounds(element, b.newBounds)
        }
        if (this.layoutEngine !== undefined) {
            this.layoutEngine(root)
        }
        this.actionDispatcher.dispatch(new UpdateModelAction(root))
        if (this.onModelSubmitted !== undefined) {
            this.onModelSubmitted(root)
        }
    }

    protected applyBounds(element: SModelElementSchema, newBounds: Bounds) {
        const e = element as any
        e.position = { x: newBounds.x, y: newBounds.y }
        e.size = { width: newBounds.width, height: newBounds.height }
    }

    protected handleRequestPopupModel(action: RequestPopupModelAction): void {
        if (this.popupModelFactory !== undefined) {
            const element = findElement(this.currentRoot, action.elementId)
            const popupRoot = this.popupModelFactory(action, element)
            if (popupRoot !== undefined) {
                popupRoot.canvasBounds = action.bounds
                this.actionDispatcher.dispatch(new SetPopupModelAction(popupRoot))
            }
        }
    }
}
