
import { AbstractParseTreeVisitor } from "antlr4ng";


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
 * This interface defines a complete generic visitor for a parse tree produced
 * by `WireQueryParser`.
 *
 * @param <Result> The return type of the visit operation. Use `void` for
 * operations with no return type.
 */
export class WireQueryVisitor<Result> extends AbstractParseTreeVisitor<Result> {
    /**
     * Visit a parse tree produced by `WireQueryParser.query`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitQuery?: (ctx: QueryContext) => Result;
    /**
     * Visit a parse tree produced by `WireQueryParser.selectItem`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitSelectItem?: (ctx: SelectItemContext) => Result;
    /**
     * Visit a parse tree produced by `WireQueryParser.aggregateCall`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitAggregateCall?: (ctx: AggregateCallContext) => Result;
    /**
     * Visit a parse tree produced by `WireQueryParser.aggregate`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitAggregate?: (ctx: AggregateContext) => Result;
    /**
     * Visit a parse tree produced by `WireQueryParser.orderItem`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitOrderItem?: (ctx: OrderItemContext) => Result;
    /**
     * Visit a parse tree produced by `WireQueryParser.fieldPath`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitFieldPath?: (ctx: FieldPathContext) => Result;
    /**
     * Visit a parse tree produced by `WireQueryParser.predicate`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitPredicate?: (ctx: PredicateContext) => Result;
    /**
     * Visit a parse tree produced by `WireQueryParser.orPredicate`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitOrPredicate?: (ctx: OrPredicateContext) => Result;
    /**
     * Visit a parse tree produced by `WireQueryParser.andPredicate`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitAndPredicate?: (ctx: AndPredicateContext) => Result;
    /**
     * Visit a parse tree produced by `WireQueryParser.notPredicate`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitNotPredicate?: (ctx: NotPredicateContext) => Result;
    /**
     * Visit a parse tree produced by `WireQueryParser.predicateAtom`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitPredicateAtom?: (ctx: PredicateAtomContext) => Result;
    /**
     * Visit a parse tree produced by `WireQueryParser.expression`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitExpression?: (ctx: ExpressionContext) => Result;
    /**
     * Visit a parse tree produced by `WireQueryParser.comparison`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitComparison?: (ctx: ComparisonContext) => Result;
    /**
     * Visit a parse tree produced by `WireQueryParser.literal`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitLiteral?: (ctx: LiteralContext) => Result;
    /**
     * Visit a parse tree produced by `WireQueryParser.ownerName`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitOwnerName?: (ctx: OwnerNameContext) => Result;
    /**
     * Visit a parse tree produced by `WireQueryParser.identifier`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitIdentifier?: (ctx: IdentifierContext) => Result;
}

