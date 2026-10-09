
import { ErrorNode, ParseTreeListener, ParserRuleContext, TerminalNode } from "antlr4ng";


import { QueryContext } from "./WireQueryParser.js";
import { SelectItemContext } from "./WireQueryParser.js";
import { AggregateCallContext } from "./WireQueryParser.js";
import { AggregateContext } from "./WireQueryParser.js";
import { OrderItemContext } from "./WireQueryParser.js";
import { FieldPathContext } from "./WireQueryParser.js";
import { PredicateContext } from "./WireQueryParser.js";
import { OrPredicateContext } from "./WireQueryParser.js";
import { AndPredicateContext } from "./WireQueryParser.js";
import { NotPredicateContext } from "./WireQueryParser.js";
import { PredicateAtomContext } from "./WireQueryParser.js";
import { ExpressionContext } from "./WireQueryParser.js";
import { ComparisonContext } from "./WireQueryParser.js";
import { LiteralContext } from "./WireQueryParser.js";
import { OwnerNameContext } from "./WireQueryParser.js";
import { IdentifierContext } from "./WireQueryParser.js";


/**
 * This interface defines a complete listener for a parse tree produced by
 * `WireQueryParser`.
 */
export class WireQueryListener implements ParseTreeListener {
    /**
     * Enter a parse tree produced by `WireQueryParser.query`.
     * @param ctx the parse tree
     */
    enterQuery?: (ctx: QueryContext) => void;
    /**
     * Exit a parse tree produced by `WireQueryParser.query`.
     * @param ctx the parse tree
     */
    exitQuery?: (ctx: QueryContext) => void;
    /**
     * Enter a parse tree produced by `WireQueryParser.selectItem`.
     * @param ctx the parse tree
     */
    enterSelectItem?: (ctx: SelectItemContext) => void;
    /**
     * Exit a parse tree produced by `WireQueryParser.selectItem`.
     * @param ctx the parse tree
     */
    exitSelectItem?: (ctx: SelectItemContext) => void;
    /**
     * Enter a parse tree produced by `WireQueryParser.aggregateCall`.
     * @param ctx the parse tree
     */
    enterAggregateCall?: (ctx: AggregateCallContext) => void;
    /**
     * Exit a parse tree produced by `WireQueryParser.aggregateCall`.
     * @param ctx the parse tree
     */
    exitAggregateCall?: (ctx: AggregateCallContext) => void;
    /**
     * Enter a parse tree produced by `WireQueryParser.aggregate`.
     * @param ctx the parse tree
     */
    enterAggregate?: (ctx: AggregateContext) => void;
    /**
     * Exit a parse tree produced by `WireQueryParser.aggregate`.
     * @param ctx the parse tree
     */
    exitAggregate?: (ctx: AggregateContext) => void;
    /**
     * Enter a parse tree produced by `WireQueryParser.orderItem`.
     * @param ctx the parse tree
     */
    enterOrderItem?: (ctx: OrderItemContext) => void;
    /**
     * Exit a parse tree produced by `WireQueryParser.orderItem`.
     * @param ctx the parse tree
     */
    exitOrderItem?: (ctx: OrderItemContext) => void;
    /**
     * Enter a parse tree produced by `WireQueryParser.fieldPath`.
     * @param ctx the parse tree
     */
    enterFieldPath?: (ctx: FieldPathContext) => void;
    /**
     * Exit a parse tree produced by `WireQueryParser.fieldPath`.
     * @param ctx the parse tree
     */
    exitFieldPath?: (ctx: FieldPathContext) => void;
    /**
     * Enter a parse tree produced by `WireQueryParser.predicate`.
     * @param ctx the parse tree
     */
    enterPredicate?: (ctx: PredicateContext) => void;
    /**
     * Exit a parse tree produced by `WireQueryParser.predicate`.
     * @param ctx the parse tree
     */
    exitPredicate?: (ctx: PredicateContext) => void;
    /**
     * Enter a parse tree produced by `WireQueryParser.orPredicate`.
     * @param ctx the parse tree
     */
    enterOrPredicate?: (ctx: OrPredicateContext) => void;
    /**
     * Exit a parse tree produced by `WireQueryParser.orPredicate`.
     * @param ctx the parse tree
     */
    exitOrPredicate?: (ctx: OrPredicateContext) => void;
    /**
     * Enter a parse tree produced by `WireQueryParser.andPredicate`.
     * @param ctx the parse tree
     */
    enterAndPredicate?: (ctx: AndPredicateContext) => void;
    /**
     * Exit a parse tree produced by `WireQueryParser.andPredicate`.
     * @param ctx the parse tree
     */
    exitAndPredicate?: (ctx: AndPredicateContext) => void;
    /**
     * Enter a parse tree produced by `WireQueryParser.notPredicate`.
     * @param ctx the parse tree
     */
    enterNotPredicate?: (ctx: NotPredicateContext) => void;
    /**
     * Exit a parse tree produced by `WireQueryParser.notPredicate`.
     * @param ctx the parse tree
     */
    exitNotPredicate?: (ctx: NotPredicateContext) => void;
    /**
     * Enter a parse tree produced by `WireQueryParser.predicateAtom`.
     * @param ctx the parse tree
     */
    enterPredicateAtom?: (ctx: PredicateAtomContext) => void;
    /**
     * Exit a parse tree produced by `WireQueryParser.predicateAtom`.
     * @param ctx the parse tree
     */
    exitPredicateAtom?: (ctx: PredicateAtomContext) => void;
    /**
     * Enter a parse tree produced by `WireQueryParser.expression`.
     * @param ctx the parse tree
     */
    enterExpression?: (ctx: ExpressionContext) => void;
    /**
     * Exit a parse tree produced by `WireQueryParser.expression`.
     * @param ctx the parse tree
     */
    exitExpression?: (ctx: ExpressionContext) => void;
    /**
     * Enter a parse tree produced by `WireQueryParser.comparison`.
     * @param ctx the parse tree
     */
    enterComparison?: (ctx: ComparisonContext) => void;
    /**
     * Exit a parse tree produced by `WireQueryParser.comparison`.
     * @param ctx the parse tree
     */
    exitComparison?: (ctx: ComparisonContext) => void;
    /**
     * Enter a parse tree produced by `WireQueryParser.literal`.
     * @param ctx the parse tree
     */
    enterLiteral?: (ctx: LiteralContext) => void;
    /**
     * Exit a parse tree produced by `WireQueryParser.literal`.
     * @param ctx the parse tree
     */
    exitLiteral?: (ctx: LiteralContext) => void;
    /**
     * Enter a parse tree produced by `WireQueryParser.ownerName`.
     * @param ctx the parse tree
     */
    enterOwnerName?: (ctx: OwnerNameContext) => void;
    /**
     * Exit a parse tree produced by `WireQueryParser.ownerName`.
     * @param ctx the parse tree
     */
    exitOwnerName?: (ctx: OwnerNameContext) => void;
    /**
     * Enter a parse tree produced by `WireQueryParser.identifier`.
     * @param ctx the parse tree
     */
    enterIdentifier?: (ctx: IdentifierContext) => void;
    /**
     * Exit a parse tree produced by `WireQueryParser.identifier`.
     * @param ctx the parse tree
     */
    exitIdentifier?: (ctx: IdentifierContext) => void;

    visitTerminal(node: TerminalNode): void {}
    visitErrorNode(node: ErrorNode): void {}
    enterEveryRule(node: ParserRuleContext): void {}
    exitEveryRule(node: ParserRuleContext): void {}
}

