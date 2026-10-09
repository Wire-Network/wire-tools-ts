
import * as antlr from "antlr4ng";
import { Token } from "antlr4ng";

import { WireQueryListener } from "./WireQueryListener.js";
import { WireQueryVisitor } from "./WireQueryVisitor.js";

// for running tests with parameters, TODO: discuss strategy for typed parameters in CI
// eslint-disable-next-line no-unused-vars
type int = number;


export class WireQueryParser extends antlr.Parser {
    public static readonly SELECT = 1;
    public static readonly FROM = 2;
    public static readonly OWNER = 3;
    public static readonly WHERE = 4;
    public static readonly GROUP = 5;
    public static readonly BY = 6;
    public static readonly HAVING = 7;
    public static readonly ORDER = 8;
    public static readonly LIMIT = 9;
    public static readonly AS = 10;
    public static readonly ASC = 11;
    public static readonly DESC = 12;
    public static readonly COUNT_AGGREGATE = 13;
    public static readonly SUM_AGGREGATE = 14;
    public static readonly AVG_AGGREGATE = 15;
    public static readonly MIN_AGGREGATE = 16;
    public static readonly MAX_AGGREGATE = 17;
    public static readonly NOT = 18;
    public static readonly AND = 19;
    public static readonly OR = 20;
    public static readonly IS = 21;
    public static readonly NULL_LITERAL = 22;
    public static readonly TRUE_LITERAL = 23;
    public static readonly FALSE_LITERAL = 24;
    public static readonly LPAREN = 25;
    public static readonly RPAREN = 26;
    public static readonly DOT = 27;
    public static readonly COMMA = 28;
    public static readonly SEMICOLON = 29;
    public static readonly STAR = 30;
    public static readonly EQ = 31;
    public static readonly NE = 32;
    public static readonly LE = 33;
    public static readonly LT = 34;
    public static readonly GE = 35;
    public static readonly GT = 36;
    public static readonly PLUS = 37;
    public static readonly MINUS = 38;
    public static readonly DECIMAL = 39;
    public static readonly INTEGER = 40;
    public static readonly STRING = 41;
    public static readonly QUOTED_IDENTIFIER = 42;
    public static readonly IDENTIFIER = 43;
    public static readonly WHITESPACE = 44;
    public static readonly RULE_query = 0;
    public static readonly RULE_selectItem = 1;
    public static readonly RULE_aggregateCall = 2;
    public static readonly RULE_aggregate = 3;
    public static readonly RULE_orderItem = 4;
    public static readonly RULE_fieldPath = 5;
    public static readonly RULE_predicate = 6;
    public static readonly RULE_orPredicate = 7;
    public static readonly RULE_andPredicate = 8;
    public static readonly RULE_notPredicate = 9;
    public static readonly RULE_predicateAtom = 10;
    public static readonly RULE_expression = 11;
    public static readonly RULE_comparison = 12;
    public static readonly RULE_literal = 13;
    public static readonly RULE_ownerName = 14;
    public static readonly RULE_identifier = 15;

    public static readonly literalNames = [
        null, "'SELECT'", "'FROM'", "'OWNER'", "'WHERE'", "'GROUP'", "'BY'", 
        "'HAVING'", "'ORDER'", "'LIMIT'", "'AS'", "'ASC'", "'DESC'", "'COUNT'", 
        "'SUM'", "'AVG'", "'MIN'", "'MAX'", "'NOT'", "'AND'", "'OR'", "'IS'", 
        "'NULL'", "'TRUE'", "'FALSE'", "'('", "')'", "'.'", "','", "';'", 
        "'*'", "'='", null, "'<='", "'<'", "'>='", "'>'", "'+'", "'-'"
    ];

    public static readonly symbolicNames = [
        null, "SELECT", "FROM", "OWNER", "WHERE", "GROUP", "BY", "HAVING", 
        "ORDER", "LIMIT", "AS", "ASC", "DESC", "COUNT_AGGREGATE", "SUM_AGGREGATE", 
        "AVG_AGGREGATE", "MIN_AGGREGATE", "MAX_AGGREGATE", "NOT", "AND", 
        "OR", "IS", "NULL_LITERAL", "TRUE_LITERAL", "FALSE_LITERAL", "LPAREN", 
        "RPAREN", "DOT", "COMMA", "SEMICOLON", "STAR", "EQ", "NE", "LE", 
        "LT", "GE", "GT", "PLUS", "MINUS", "DECIMAL", "INTEGER", "STRING", 
        "QUOTED_IDENTIFIER", "IDENTIFIER", "WHITESPACE"
    ];
    public static readonly ruleNames = [
        "query", "selectItem", "aggregateCall", "aggregate", "orderItem", 
        "fieldPath", "predicate", "orPredicate", "andPredicate", "notPredicate", 
        "predicateAtom", "expression", "comparison", "literal", "ownerName", 
        "identifier",
    ];

    public get grammarFileName(): string { return "WireQuery.g4"; }
    public get literalNames(): (string | null)[] { return WireQueryParser.literalNames; }
    public get symbolicNames(): (string | null)[] { return WireQueryParser.symbolicNames; }
    public get ruleNames(): string[] { return WireQueryParser.ruleNames; }
    public get serializedATN(): number[] { return WireQueryParser._serializedATN; }

    protected createFailedPredicateException(predicate?: string, message?: string): antlr.FailedPredicateException {
        return new antlr.FailedPredicateException(this, predicate, message);
    }

    public constructor(input: antlr.TokenStream) {
        super(input);
        this.interpreter = new antlr.ParserATNSimulator(this, WireQueryParser._ATN, WireQueryParser.decisionsToDFA, new antlr.PredictionContextCache());
    }
    public query(): QueryContext {
        let localContext = new QueryContext(this.context, this.state);
        this.enterRule(localContext, 0, WireQueryParser.RULE_query);
        let _la: number;
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 32;
            this.match(WireQueryParser.SELECT);
            this.state = 33;
            this.selectItem();
            this.state = 38;
            this.errorHandler.sync(this);
            _la = this.tokenStream.LA(1);
            while (_la === 28) {
                {
                {
                this.state = 34;
                this.match(WireQueryParser.COMMA);
                this.state = 35;
                this.selectItem();
                }
                }
                this.state = 40;
                this.errorHandler.sync(this);
                _la = this.tokenStream.LA(1);
            }
            this.state = 41;
            this.match(WireQueryParser.FROM);
            this.state = 45;
            this.errorHandler.sync(this);
            switch (this.interpreter.adaptivePredict(this.tokenStream, 1, this.context) ) {
            case 1:
                {
                this.state = 42;
                localContext._owner = this.identifier();
                this.state = 43;
                this.match(WireQueryParser.DOT);
                }
                break;
            }
            this.state = 47;
            localContext._table = this.identifier();
            this.state = 57;
            this.errorHandler.sync(this);
            _la = this.tokenStream.LA(1);
            if (_la === 3) {
                {
                this.state = 48;
                this.match(WireQueryParser.OWNER);
                this.state = 49;
                this.ownerName();
                this.state = 54;
                this.errorHandler.sync(this);
                _la = this.tokenStream.LA(1);
                while (_la === 28) {
                    {
                    {
                    this.state = 50;
                    this.match(WireQueryParser.COMMA);
                    this.state = 51;
                    this.ownerName();
                    }
                    }
                    this.state = 56;
                    this.errorHandler.sync(this);
                    _la = this.tokenStream.LA(1);
                }
                }
            }

            this.state = 61;
            this.errorHandler.sync(this);
            _la = this.tokenStream.LA(1);
            if (_la === 4) {
                {
                this.state = 59;
                this.match(WireQueryParser.WHERE);
                this.state = 60;
                localContext._wherePredicate = this.predicate();
                }
            }

            this.state = 73;
            this.errorHandler.sync(this);
            _la = this.tokenStream.LA(1);
            if (_la === 5) {
                {
                this.state = 63;
                this.match(WireQueryParser.GROUP);
                this.state = 64;
                this.match(WireQueryParser.BY);
                this.state = 65;
                this.fieldPath();
                this.state = 70;
                this.errorHandler.sync(this);
                _la = this.tokenStream.LA(1);
                while (_la === 28) {
                    {
                    {
                    this.state = 66;
                    this.match(WireQueryParser.COMMA);
                    this.state = 67;
                    this.fieldPath();
                    }
                    }
                    this.state = 72;
                    this.errorHandler.sync(this);
                    _la = this.tokenStream.LA(1);
                }
                }
            }

            this.state = 77;
            this.errorHandler.sync(this);
            _la = this.tokenStream.LA(1);
            if (_la === 7) {
                {
                this.state = 75;
                this.match(WireQueryParser.HAVING);
                this.state = 76;
                localContext._havingPredicate = this.predicate();
                }
            }

            this.state = 89;
            this.errorHandler.sync(this);
            _la = this.tokenStream.LA(1);
            if (_la === 8) {
                {
                this.state = 79;
                this.match(WireQueryParser.ORDER);
                this.state = 80;
                this.match(WireQueryParser.BY);
                this.state = 81;
                this.orderItem();
                this.state = 86;
                this.errorHandler.sync(this);
                _la = this.tokenStream.LA(1);
                while (_la === 28) {
                    {
                    {
                    this.state = 82;
                    this.match(WireQueryParser.COMMA);
                    this.state = 83;
                    this.orderItem();
                    }
                    }
                    this.state = 88;
                    this.errorHandler.sync(this);
                    _la = this.tokenStream.LA(1);
                }
                }
            }

            this.state = 93;
            this.errorHandler.sync(this);
            _la = this.tokenStream.LA(1);
            if (_la === 9) {
                {
                this.state = 91;
                this.match(WireQueryParser.LIMIT);
                this.state = 92;
                localContext._limit = this.match(WireQueryParser.INTEGER);
                }
            }

            this.state = 96;
            this.errorHandler.sync(this);
            _la = this.tokenStream.LA(1);
            if (_la === 29) {
                {
                this.state = 95;
                this.match(WireQueryParser.SEMICOLON);
                }
            }

            this.state = 98;
            this.match(WireQueryParser.EOF);
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public selectItem(): SelectItemContext {
        let localContext = new SelectItemContext(this.context, this.state);
        this.enterRule(localContext, 2, WireQueryParser.RULE_selectItem);
        let _la: number;
        try {
            this.state = 110;
            this.errorHandler.sync(this);
            switch (this.tokenStream.LA(1)) {
            case WireQueryParser.OWNER:
            case WireQueryParser.QUOTED_IDENTIFIER:
            case WireQueryParser.IDENTIFIER:
                this.enterOuterAlt(localContext, 1);
                {
                this.state = 100;
                this.fieldPath();
                this.state = 103;
                this.errorHandler.sync(this);
                _la = this.tokenStream.LA(1);
                if (_la === 10) {
                    {
                    this.state = 101;
                    this.match(WireQueryParser.AS);
                    this.state = 102;
                    this.identifier();
                    }
                }

                }
                break;
            case WireQueryParser.COUNT_AGGREGATE:
            case WireQueryParser.SUM_AGGREGATE:
            case WireQueryParser.AVG_AGGREGATE:
            case WireQueryParser.MIN_AGGREGATE:
            case WireQueryParser.MAX_AGGREGATE:
                this.enterOuterAlt(localContext, 2);
                {
                this.state = 105;
                this.aggregateCall();
                this.state = 106;
                this.match(WireQueryParser.AS);
                this.state = 107;
                this.identifier();
                }
                break;
            case WireQueryParser.STAR:
                this.enterOuterAlt(localContext, 3);
                {
                this.state = 109;
                this.match(WireQueryParser.STAR);
                }
                break;
            default:
                throw new antlr.NoViableAltException(this);
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public aggregateCall(): AggregateCallContext {
        let localContext = new AggregateCallContext(this.context, this.state);
        this.enterRule(localContext, 4, WireQueryParser.RULE_aggregateCall);
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 112;
            this.aggregate();
            this.state = 113;
            this.match(WireQueryParser.LPAREN);
            this.state = 116;
            this.errorHandler.sync(this);
            switch (this.tokenStream.LA(1)) {
            case WireQueryParser.STAR:
                {
                this.state = 114;
                this.match(WireQueryParser.STAR);
                }
                break;
            case WireQueryParser.OWNER:
            case WireQueryParser.QUOTED_IDENTIFIER:
            case WireQueryParser.IDENTIFIER:
                {
                this.state = 115;
                this.fieldPath();
                }
                break;
            default:
                throw new antlr.NoViableAltException(this);
            }
            this.state = 118;
            this.match(WireQueryParser.RPAREN);
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public aggregate(): AggregateContext {
        let localContext = new AggregateContext(this.context, this.state);
        this.enterRule(localContext, 6, WireQueryParser.RULE_aggregate);
        let _la: number;
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 120;
            _la = this.tokenStream.LA(1);
            if(!((((_la) & ~0x1F) === 0 && ((1 << _la) & 253952) !== 0))) {
            this.errorHandler.recoverInline(this);
            }
            else {
                this.errorHandler.reportMatch(this);
                this.consume();
            }
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public orderItem(): OrderItemContext {
        let localContext = new OrderItemContext(this.context, this.state);
        this.enterRule(localContext, 8, WireQueryParser.RULE_orderItem);
        let _la: number;
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 122;
            this.identifier();
            this.state = 124;
            this.errorHandler.sync(this);
            _la = this.tokenStream.LA(1);
            if (_la === 11 || _la === 12) {
                {
                this.state = 123;
                _la = this.tokenStream.LA(1);
                if(!(_la === 11 || _la === 12)) {
                this.errorHandler.recoverInline(this);
                }
                else {
                    this.errorHandler.reportMatch(this);
                    this.consume();
                }
                }
            }

            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public fieldPath(): FieldPathContext {
        let localContext = new FieldPathContext(this.context, this.state);
        this.enterRule(localContext, 10, WireQueryParser.RULE_fieldPath);
        let _la: number;
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 126;
            this.identifier();
            this.state = 131;
            this.errorHandler.sync(this);
            _la = this.tokenStream.LA(1);
            while (_la === 27) {
                {
                {
                this.state = 127;
                this.match(WireQueryParser.DOT);
                this.state = 128;
                this.identifier();
                }
                }
                this.state = 133;
                this.errorHandler.sync(this);
                _la = this.tokenStream.LA(1);
            }
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public predicate(): PredicateContext {
        let localContext = new PredicateContext(this.context, this.state);
        this.enterRule(localContext, 12, WireQueryParser.RULE_predicate);
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 134;
            this.orPredicate();
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public orPredicate(): OrPredicateContext {
        let localContext = new OrPredicateContext(this.context, this.state);
        this.enterRule(localContext, 14, WireQueryParser.RULE_orPredicate);
        let _la: number;
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 136;
            this.andPredicate();
            this.state = 141;
            this.errorHandler.sync(this);
            _la = this.tokenStream.LA(1);
            while (_la === 20) {
                {
                {
                this.state = 137;
                this.match(WireQueryParser.OR);
                this.state = 138;
                this.andPredicate();
                }
                }
                this.state = 143;
                this.errorHandler.sync(this);
                _la = this.tokenStream.LA(1);
            }
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public andPredicate(): AndPredicateContext {
        let localContext = new AndPredicateContext(this.context, this.state);
        this.enterRule(localContext, 16, WireQueryParser.RULE_andPredicate);
        let _la: number;
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 144;
            this.notPredicate();
            this.state = 149;
            this.errorHandler.sync(this);
            _la = this.tokenStream.LA(1);
            while (_la === 19) {
                {
                {
                this.state = 145;
                this.match(WireQueryParser.AND);
                this.state = 146;
                this.notPredicate();
                }
                }
                this.state = 151;
                this.errorHandler.sync(this);
                _la = this.tokenStream.LA(1);
            }
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public notPredicate(): NotPredicateContext {
        let localContext = new NotPredicateContext(this.context, this.state);
        this.enterRule(localContext, 18, WireQueryParser.RULE_notPredicate);
        try {
            this.state = 155;
            this.errorHandler.sync(this);
            switch (this.tokenStream.LA(1)) {
            case WireQueryParser.NOT:
                this.enterOuterAlt(localContext, 1);
                {
                this.state = 152;
                this.match(WireQueryParser.NOT);
                this.state = 153;
                this.notPredicate();
                }
                break;
            case WireQueryParser.OWNER:
            case WireQueryParser.COUNT_AGGREGATE:
            case WireQueryParser.SUM_AGGREGATE:
            case WireQueryParser.AVG_AGGREGATE:
            case WireQueryParser.MIN_AGGREGATE:
            case WireQueryParser.MAX_AGGREGATE:
            case WireQueryParser.NULL_LITERAL:
            case WireQueryParser.TRUE_LITERAL:
            case WireQueryParser.FALSE_LITERAL:
            case WireQueryParser.LPAREN:
            case WireQueryParser.PLUS:
            case WireQueryParser.MINUS:
            case WireQueryParser.DECIMAL:
            case WireQueryParser.INTEGER:
            case WireQueryParser.STRING:
            case WireQueryParser.QUOTED_IDENTIFIER:
            case WireQueryParser.IDENTIFIER:
                this.enterOuterAlt(localContext, 2);
                {
                this.state = 154;
                this.predicateAtom();
                }
                break;
            default:
                throw new antlr.NoViableAltException(this);
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public predicateAtom(): PredicateAtomContext {
        let localContext = new PredicateAtomContext(this.context, this.state);
        this.enterRule(localContext, 20, WireQueryParser.RULE_predicateAtom);
        let _la: number;
        try {
            this.state = 172;
            this.errorHandler.sync(this);
            switch (this.interpreter.adaptivePredict(this.tokenStream, 21, this.context) ) {
            case 1:
                this.enterOuterAlt(localContext, 1);
                {
                this.state = 157;
                this.match(WireQueryParser.LPAREN);
                this.state = 158;
                this.predicate();
                this.state = 159;
                this.match(WireQueryParser.RPAREN);
                }
                break;
            case 2:
                this.enterOuterAlt(localContext, 2);
                {
                this.state = 161;
                this.expression();
                this.state = 162;
                this.comparison();
                this.state = 163;
                this.expression();
                }
                break;
            case 3:
                this.enterOuterAlt(localContext, 3);
                {
                this.state = 165;
                this.expression();
                this.state = 166;
                this.match(WireQueryParser.IS);
                this.state = 168;
                this.errorHandler.sync(this);
                _la = this.tokenStream.LA(1);
                if (_la === 18) {
                    {
                    this.state = 167;
                    this.match(WireQueryParser.NOT);
                    }
                }

                this.state = 170;
                this.match(WireQueryParser.NULL_LITERAL);
                }
                break;
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public expression(): ExpressionContext {
        let localContext = new ExpressionContext(this.context, this.state);
        this.enterRule(localContext, 22, WireQueryParser.RULE_expression);
        try {
            this.state = 177;
            this.errorHandler.sync(this);
            switch (this.tokenStream.LA(1)) {
            case WireQueryParser.OWNER:
            case WireQueryParser.QUOTED_IDENTIFIER:
            case WireQueryParser.IDENTIFIER:
                this.enterOuterAlt(localContext, 1);
                {
                this.state = 174;
                this.fieldPath();
                }
                break;
            case WireQueryParser.NULL_LITERAL:
            case WireQueryParser.TRUE_LITERAL:
            case WireQueryParser.FALSE_LITERAL:
            case WireQueryParser.PLUS:
            case WireQueryParser.MINUS:
            case WireQueryParser.DECIMAL:
            case WireQueryParser.INTEGER:
            case WireQueryParser.STRING:
                this.enterOuterAlt(localContext, 2);
                {
                this.state = 175;
                this.literal();
                }
                break;
            case WireQueryParser.COUNT_AGGREGATE:
            case WireQueryParser.SUM_AGGREGATE:
            case WireQueryParser.AVG_AGGREGATE:
            case WireQueryParser.MIN_AGGREGATE:
            case WireQueryParser.MAX_AGGREGATE:
                this.enterOuterAlt(localContext, 3);
                {
                this.state = 176;
                this.aggregateCall();
                }
                break;
            default:
                throw new antlr.NoViableAltException(this);
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public comparison(): ComparisonContext {
        let localContext = new ComparisonContext(this.context, this.state);
        this.enterRule(localContext, 24, WireQueryParser.RULE_comparison);
        let _la: number;
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 179;
            _la = this.tokenStream.LA(1);
            if(!(((((_la - 31)) & ~0x1F) === 0 && ((1 << (_la - 31)) & 63) !== 0))) {
            this.errorHandler.recoverInline(this);
            }
            else {
                this.errorHandler.reportMatch(this);
                this.consume();
            }
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public literal(): LiteralContext {
        let localContext = new LiteralContext(this.context, this.state);
        this.enterRule(localContext, 26, WireQueryParser.RULE_literal);
        let _la: number;
        try {
            this.state = 189;
            this.errorHandler.sync(this);
            switch (this.tokenStream.LA(1)) {
            case WireQueryParser.STRING:
                this.enterOuterAlt(localContext, 1);
                {
                this.state = 181;
                this.match(WireQueryParser.STRING);
                }
                break;
            case WireQueryParser.PLUS:
            case WireQueryParser.MINUS:
            case WireQueryParser.DECIMAL:
            case WireQueryParser.INTEGER:
                this.enterOuterAlt(localContext, 2);
                {
                this.state = 183;
                this.errorHandler.sync(this);
                _la = this.tokenStream.LA(1);
                if (_la === 37 || _la === 38) {
                    {
                    this.state = 182;
                    _la = this.tokenStream.LA(1);
                    if(!(_la === 37 || _la === 38)) {
                    this.errorHandler.recoverInline(this);
                    }
                    else {
                        this.errorHandler.reportMatch(this);
                        this.consume();
                    }
                    }
                }

                this.state = 185;
                _la = this.tokenStream.LA(1);
                if(!(_la === 39 || _la === 40)) {
                this.errorHandler.recoverInline(this);
                }
                else {
                    this.errorHandler.reportMatch(this);
                    this.consume();
                }
                }
                break;
            case WireQueryParser.TRUE_LITERAL:
                this.enterOuterAlt(localContext, 3);
                {
                this.state = 186;
                this.match(WireQueryParser.TRUE_LITERAL);
                }
                break;
            case WireQueryParser.FALSE_LITERAL:
                this.enterOuterAlt(localContext, 4);
                {
                this.state = 187;
                this.match(WireQueryParser.FALSE_LITERAL);
                }
                break;
            case WireQueryParser.NULL_LITERAL:
                this.enterOuterAlt(localContext, 5);
                {
                this.state = 188;
                this.match(WireQueryParser.NULL_LITERAL);
                }
                break;
            default:
                throw new antlr.NoViableAltException(this);
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public ownerName(): OwnerNameContext {
        let localContext = new OwnerNameContext(this.context, this.state);
        this.enterRule(localContext, 28, WireQueryParser.RULE_ownerName);
        try {
            this.state = 193;
            this.errorHandler.sync(this);
            switch (this.tokenStream.LA(1)) {
            case WireQueryParser.STRING:
                this.enterOuterAlt(localContext, 1);
                {
                this.state = 191;
                this.match(WireQueryParser.STRING);
                }
                break;
            case WireQueryParser.OWNER:
            case WireQueryParser.QUOTED_IDENTIFIER:
            case WireQueryParser.IDENTIFIER:
                this.enterOuterAlt(localContext, 2);
                {
                this.state = 192;
                this.identifier();
                }
                break;
            default:
                throw new antlr.NoViableAltException(this);
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public identifier(): IdentifierContext {
        let localContext = new IdentifierContext(this.context, this.state);
        this.enterRule(localContext, 30, WireQueryParser.RULE_identifier);
        let _la: number;
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 195;
            _la = this.tokenStream.LA(1);
            if(!(_la === 3 || _la === 42 || _la === 43)) {
            this.errorHandler.recoverInline(this);
            }
            else {
                this.errorHandler.reportMatch(this);
                this.consume();
            }
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }

    public static readonly _serializedATN: number[] = [
        4,1,44,198,2,0,7,0,2,1,7,1,2,2,7,2,2,3,7,3,2,4,7,4,2,5,7,5,2,6,7,
        6,2,7,7,7,2,8,7,8,2,9,7,9,2,10,7,10,2,11,7,11,2,12,7,12,2,13,7,13,
        2,14,7,14,2,15,7,15,1,0,1,0,1,0,1,0,5,0,37,8,0,10,0,12,0,40,9,0,
        1,0,1,0,1,0,1,0,3,0,46,8,0,1,0,1,0,1,0,1,0,1,0,5,0,53,8,0,10,0,12,
        0,56,9,0,3,0,58,8,0,1,0,1,0,3,0,62,8,0,1,0,1,0,1,0,1,0,1,0,5,0,69,
        8,0,10,0,12,0,72,9,0,3,0,74,8,0,1,0,1,0,3,0,78,8,0,1,0,1,0,1,0,1,
        0,1,0,5,0,85,8,0,10,0,12,0,88,9,0,3,0,90,8,0,1,0,1,0,3,0,94,8,0,
        1,0,3,0,97,8,0,1,0,1,0,1,1,1,1,1,1,3,1,104,8,1,1,1,1,1,1,1,1,1,1,
        1,3,1,111,8,1,1,2,1,2,1,2,1,2,3,2,117,8,2,1,2,1,2,1,3,1,3,1,4,1,
        4,3,4,125,8,4,1,5,1,5,1,5,5,5,130,8,5,10,5,12,5,133,9,5,1,6,1,6,
        1,7,1,7,1,7,5,7,140,8,7,10,7,12,7,143,9,7,1,8,1,8,1,8,5,8,148,8,
        8,10,8,12,8,151,9,8,1,9,1,9,1,9,3,9,156,8,9,1,10,1,10,1,10,1,10,
        1,10,1,10,1,10,1,10,1,10,1,10,1,10,3,10,169,8,10,1,10,1,10,3,10,
        173,8,10,1,11,1,11,1,11,3,11,178,8,11,1,12,1,12,1,13,1,13,3,13,184,
        8,13,1,13,1,13,1,13,1,13,3,13,190,8,13,1,14,1,14,3,14,194,8,14,1,
        15,1,15,1,15,0,0,16,0,2,4,6,8,10,12,14,16,18,20,22,24,26,28,30,0,
        6,1,0,13,17,1,0,11,12,1,0,31,36,1,0,37,38,1,0,39,40,2,0,3,3,42,43,
        213,0,32,1,0,0,0,2,110,1,0,0,0,4,112,1,0,0,0,6,120,1,0,0,0,8,122,
        1,0,0,0,10,126,1,0,0,0,12,134,1,0,0,0,14,136,1,0,0,0,16,144,1,0,
        0,0,18,155,1,0,0,0,20,172,1,0,0,0,22,177,1,0,0,0,24,179,1,0,0,0,
        26,189,1,0,0,0,28,193,1,0,0,0,30,195,1,0,0,0,32,33,5,1,0,0,33,38,
        3,2,1,0,34,35,5,28,0,0,35,37,3,2,1,0,36,34,1,0,0,0,37,40,1,0,0,0,
        38,36,1,0,0,0,38,39,1,0,0,0,39,41,1,0,0,0,40,38,1,0,0,0,41,45,5,
        2,0,0,42,43,3,30,15,0,43,44,5,27,0,0,44,46,1,0,0,0,45,42,1,0,0,0,
        45,46,1,0,0,0,46,47,1,0,0,0,47,57,3,30,15,0,48,49,5,3,0,0,49,54,
        3,28,14,0,50,51,5,28,0,0,51,53,3,28,14,0,52,50,1,0,0,0,53,56,1,0,
        0,0,54,52,1,0,0,0,54,55,1,0,0,0,55,58,1,0,0,0,56,54,1,0,0,0,57,48,
        1,0,0,0,57,58,1,0,0,0,58,61,1,0,0,0,59,60,5,4,0,0,60,62,3,12,6,0,
        61,59,1,0,0,0,61,62,1,0,0,0,62,73,1,0,0,0,63,64,5,5,0,0,64,65,5,
        6,0,0,65,70,3,10,5,0,66,67,5,28,0,0,67,69,3,10,5,0,68,66,1,0,0,0,
        69,72,1,0,0,0,70,68,1,0,0,0,70,71,1,0,0,0,71,74,1,0,0,0,72,70,1,
        0,0,0,73,63,1,0,0,0,73,74,1,0,0,0,74,77,1,0,0,0,75,76,5,7,0,0,76,
        78,3,12,6,0,77,75,1,0,0,0,77,78,1,0,0,0,78,89,1,0,0,0,79,80,5,8,
        0,0,80,81,5,6,0,0,81,86,3,8,4,0,82,83,5,28,0,0,83,85,3,8,4,0,84,
        82,1,0,0,0,85,88,1,0,0,0,86,84,1,0,0,0,86,87,1,0,0,0,87,90,1,0,0,
        0,88,86,1,0,0,0,89,79,1,0,0,0,89,90,1,0,0,0,90,93,1,0,0,0,91,92,
        5,9,0,0,92,94,5,40,0,0,93,91,1,0,0,0,93,94,1,0,0,0,94,96,1,0,0,0,
        95,97,5,29,0,0,96,95,1,0,0,0,96,97,1,0,0,0,97,98,1,0,0,0,98,99,5,
        0,0,1,99,1,1,0,0,0,100,103,3,10,5,0,101,102,5,10,0,0,102,104,3,30,
        15,0,103,101,1,0,0,0,103,104,1,0,0,0,104,111,1,0,0,0,105,106,3,4,
        2,0,106,107,5,10,0,0,107,108,3,30,15,0,108,111,1,0,0,0,109,111,5,
        30,0,0,110,100,1,0,0,0,110,105,1,0,0,0,110,109,1,0,0,0,111,3,1,0,
        0,0,112,113,3,6,3,0,113,116,5,25,0,0,114,117,5,30,0,0,115,117,3,
        10,5,0,116,114,1,0,0,0,116,115,1,0,0,0,117,118,1,0,0,0,118,119,5,
        26,0,0,119,5,1,0,0,0,120,121,7,0,0,0,121,7,1,0,0,0,122,124,3,30,
        15,0,123,125,7,1,0,0,124,123,1,0,0,0,124,125,1,0,0,0,125,9,1,0,0,
        0,126,131,3,30,15,0,127,128,5,27,0,0,128,130,3,30,15,0,129,127,1,
        0,0,0,130,133,1,0,0,0,131,129,1,0,0,0,131,132,1,0,0,0,132,11,1,0,
        0,0,133,131,1,0,0,0,134,135,3,14,7,0,135,13,1,0,0,0,136,141,3,16,
        8,0,137,138,5,20,0,0,138,140,3,16,8,0,139,137,1,0,0,0,140,143,1,
        0,0,0,141,139,1,0,0,0,141,142,1,0,0,0,142,15,1,0,0,0,143,141,1,0,
        0,0,144,149,3,18,9,0,145,146,5,19,0,0,146,148,3,18,9,0,147,145,1,
        0,0,0,148,151,1,0,0,0,149,147,1,0,0,0,149,150,1,0,0,0,150,17,1,0,
        0,0,151,149,1,0,0,0,152,153,5,18,0,0,153,156,3,18,9,0,154,156,3,
        20,10,0,155,152,1,0,0,0,155,154,1,0,0,0,156,19,1,0,0,0,157,158,5,
        25,0,0,158,159,3,12,6,0,159,160,5,26,0,0,160,173,1,0,0,0,161,162,
        3,22,11,0,162,163,3,24,12,0,163,164,3,22,11,0,164,173,1,0,0,0,165,
        166,3,22,11,0,166,168,5,21,0,0,167,169,5,18,0,0,168,167,1,0,0,0,
        168,169,1,0,0,0,169,170,1,0,0,0,170,171,5,22,0,0,171,173,1,0,0,0,
        172,157,1,0,0,0,172,161,1,0,0,0,172,165,1,0,0,0,173,21,1,0,0,0,174,
        178,3,10,5,0,175,178,3,26,13,0,176,178,3,4,2,0,177,174,1,0,0,0,177,
        175,1,0,0,0,177,176,1,0,0,0,178,23,1,0,0,0,179,180,7,2,0,0,180,25,
        1,0,0,0,181,190,5,41,0,0,182,184,7,3,0,0,183,182,1,0,0,0,183,184,
        1,0,0,0,184,185,1,0,0,0,185,190,7,4,0,0,186,190,5,23,0,0,187,190,
        5,24,0,0,188,190,5,22,0,0,189,181,1,0,0,0,189,183,1,0,0,0,189,186,
        1,0,0,0,189,187,1,0,0,0,189,188,1,0,0,0,190,27,1,0,0,0,191,194,5,
        41,0,0,192,194,3,30,15,0,193,191,1,0,0,0,193,192,1,0,0,0,194,29,
        1,0,0,0,195,196,7,5,0,0,196,31,1,0,0,0,26,38,45,54,57,61,70,73,77,
        86,89,93,96,103,110,116,124,131,141,149,155,168,172,177,183,189,
        193
    ];

    private static __ATN: antlr.ATN;
    public static get _ATN(): antlr.ATN {
        if (!WireQueryParser.__ATN) {
            WireQueryParser.__ATN = new antlr.ATNDeserializer().deserialize(WireQueryParser._serializedATN);
        }

        return WireQueryParser.__ATN;
    }


    private static readonly vocabulary = new antlr.Vocabulary(WireQueryParser.literalNames, WireQueryParser.symbolicNames, []);

    public override get vocabulary(): antlr.Vocabulary {
        return WireQueryParser.vocabulary;
    }

    private static readonly decisionsToDFA = WireQueryParser._ATN.decisionToState.map( (ds: antlr.DecisionState, index: number) => new antlr.DFA(ds, index) );
}

export class QueryContext extends antlr.ParserRuleContext {
    public _owner?: IdentifierContext;
    public _table?: IdentifierContext;
    public _wherePredicate?: PredicateContext;
    public _havingPredicate?: PredicateContext;
    public _limit?: Token | null;
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public SELECT(): antlr.TerminalNode {
        return this.getToken(WireQueryParser.SELECT, 0)!;
    }
    public selectItem(): SelectItemContext[];
    public selectItem(i: number): SelectItemContext | null;
    public selectItem(i?: number): SelectItemContext[] | SelectItemContext | null {
        if (i === undefined) {
            return this.getRuleContexts(SelectItemContext);
        }

        return this.getRuleContext(i, SelectItemContext);
    }
    public FROM(): antlr.TerminalNode {
        return this.getToken(WireQueryParser.FROM, 0)!;
    }
    public EOF(): antlr.TerminalNode {
        return this.getToken(WireQueryParser.EOF, 0)!;
    }
    public identifier(): IdentifierContext[];
    public identifier(i: number): IdentifierContext | null;
    public identifier(i?: number): IdentifierContext[] | IdentifierContext | null {
        if (i === undefined) {
            return this.getRuleContexts(IdentifierContext);
        }

        return this.getRuleContext(i, IdentifierContext);
    }
    public COMMA(): antlr.TerminalNode[];
    public COMMA(i: number): antlr.TerminalNode | null;
    public COMMA(i?: number): antlr.TerminalNode | null | antlr.TerminalNode[] {
    	if (i === undefined) {
    		return this.getTokens(WireQueryParser.COMMA);
    	} else {
    		return this.getToken(WireQueryParser.COMMA, i);
    	}
    }
    public DOT(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.DOT, 0);
    }
    public OWNER(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.OWNER, 0);
    }
    public ownerName(): OwnerNameContext[];
    public ownerName(i: number): OwnerNameContext | null;
    public ownerName(i?: number): OwnerNameContext[] | OwnerNameContext | null {
        if (i === undefined) {
            return this.getRuleContexts(OwnerNameContext);
        }

        return this.getRuleContext(i, OwnerNameContext);
    }
    public WHERE(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.WHERE, 0);
    }
    public GROUP(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.GROUP, 0);
    }
    public BY(): antlr.TerminalNode[];
    public BY(i: number): antlr.TerminalNode | null;
    public BY(i?: number): antlr.TerminalNode | null | antlr.TerminalNode[] {
    	if (i === undefined) {
    		return this.getTokens(WireQueryParser.BY);
    	} else {
    		return this.getToken(WireQueryParser.BY, i);
    	}
    }
    public fieldPath(): FieldPathContext[];
    public fieldPath(i: number): FieldPathContext | null;
    public fieldPath(i?: number): FieldPathContext[] | FieldPathContext | null {
        if (i === undefined) {
            return this.getRuleContexts(FieldPathContext);
        }

        return this.getRuleContext(i, FieldPathContext);
    }
    public HAVING(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.HAVING, 0);
    }
    public ORDER(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.ORDER, 0);
    }
    public orderItem(): OrderItemContext[];
    public orderItem(i: number): OrderItemContext | null;
    public orderItem(i?: number): OrderItemContext[] | OrderItemContext | null {
        if (i === undefined) {
            return this.getRuleContexts(OrderItemContext);
        }

        return this.getRuleContext(i, OrderItemContext);
    }
    public LIMIT(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.LIMIT, 0);
    }
    public SEMICOLON(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.SEMICOLON, 0);
    }
    public predicate(): PredicateContext[];
    public predicate(i: number): PredicateContext | null;
    public predicate(i?: number): PredicateContext[] | PredicateContext | null {
        if (i === undefined) {
            return this.getRuleContexts(PredicateContext);
        }

        return this.getRuleContext(i, PredicateContext);
    }
    public INTEGER(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.INTEGER, 0);
    }
    public override get ruleIndex(): number {
        return WireQueryParser.RULE_query;
    }
    public override enterRule(listener: WireQueryListener): void {
        if(listener.enterQuery) {
             listener.enterQuery(this);
        }
    }
    public override exitRule(listener: WireQueryListener): void {
        if(listener.exitQuery) {
             listener.exitQuery(this);
        }
    }
    public override accept<Result>(visitor: WireQueryVisitor<Result>): Result | null {
        if (visitor.visitQuery) {
            return visitor.visitQuery(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class SelectItemContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public fieldPath(): FieldPathContext | null {
        return this.getRuleContext(0, FieldPathContext);
    }
    public AS(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.AS, 0);
    }
    public identifier(): IdentifierContext | null {
        return this.getRuleContext(0, IdentifierContext);
    }
    public aggregateCall(): AggregateCallContext | null {
        return this.getRuleContext(0, AggregateCallContext);
    }
    public STAR(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.STAR, 0);
    }
    public override get ruleIndex(): number {
        return WireQueryParser.RULE_selectItem;
    }
    public override enterRule(listener: WireQueryListener): void {
        if(listener.enterSelectItem) {
             listener.enterSelectItem(this);
        }
    }
    public override exitRule(listener: WireQueryListener): void {
        if(listener.exitSelectItem) {
             listener.exitSelectItem(this);
        }
    }
    public override accept<Result>(visitor: WireQueryVisitor<Result>): Result | null {
        if (visitor.visitSelectItem) {
            return visitor.visitSelectItem(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class AggregateCallContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public aggregate(): AggregateContext {
        return this.getRuleContext(0, AggregateContext)!;
    }
    public LPAREN(): antlr.TerminalNode {
        return this.getToken(WireQueryParser.LPAREN, 0)!;
    }
    public RPAREN(): antlr.TerminalNode {
        return this.getToken(WireQueryParser.RPAREN, 0)!;
    }
    public STAR(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.STAR, 0);
    }
    public fieldPath(): FieldPathContext | null {
        return this.getRuleContext(0, FieldPathContext);
    }
    public override get ruleIndex(): number {
        return WireQueryParser.RULE_aggregateCall;
    }
    public override enterRule(listener: WireQueryListener): void {
        if(listener.enterAggregateCall) {
             listener.enterAggregateCall(this);
        }
    }
    public override exitRule(listener: WireQueryListener): void {
        if(listener.exitAggregateCall) {
             listener.exitAggregateCall(this);
        }
    }
    public override accept<Result>(visitor: WireQueryVisitor<Result>): Result | null {
        if (visitor.visitAggregateCall) {
            return visitor.visitAggregateCall(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class AggregateContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public COUNT_AGGREGATE(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.COUNT_AGGREGATE, 0);
    }
    public SUM_AGGREGATE(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.SUM_AGGREGATE, 0);
    }
    public AVG_AGGREGATE(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.AVG_AGGREGATE, 0);
    }
    public MIN_AGGREGATE(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.MIN_AGGREGATE, 0);
    }
    public MAX_AGGREGATE(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.MAX_AGGREGATE, 0);
    }
    public override get ruleIndex(): number {
        return WireQueryParser.RULE_aggregate;
    }
    public override enterRule(listener: WireQueryListener): void {
        if(listener.enterAggregate) {
             listener.enterAggregate(this);
        }
    }
    public override exitRule(listener: WireQueryListener): void {
        if(listener.exitAggregate) {
             listener.exitAggregate(this);
        }
    }
    public override accept<Result>(visitor: WireQueryVisitor<Result>): Result | null {
        if (visitor.visitAggregate) {
            return visitor.visitAggregate(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class OrderItemContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public identifier(): IdentifierContext {
        return this.getRuleContext(0, IdentifierContext)!;
    }
    public ASC(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.ASC, 0);
    }
    public DESC(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.DESC, 0);
    }
    public override get ruleIndex(): number {
        return WireQueryParser.RULE_orderItem;
    }
    public override enterRule(listener: WireQueryListener): void {
        if(listener.enterOrderItem) {
             listener.enterOrderItem(this);
        }
    }
    public override exitRule(listener: WireQueryListener): void {
        if(listener.exitOrderItem) {
             listener.exitOrderItem(this);
        }
    }
    public override accept<Result>(visitor: WireQueryVisitor<Result>): Result | null {
        if (visitor.visitOrderItem) {
            return visitor.visitOrderItem(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class FieldPathContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public identifier(): IdentifierContext[];
    public identifier(i: number): IdentifierContext | null;
    public identifier(i?: number): IdentifierContext[] | IdentifierContext | null {
        if (i === undefined) {
            return this.getRuleContexts(IdentifierContext);
        }

        return this.getRuleContext(i, IdentifierContext);
    }
    public DOT(): antlr.TerminalNode[];
    public DOT(i: number): antlr.TerminalNode | null;
    public DOT(i?: number): antlr.TerminalNode | null | antlr.TerminalNode[] {
    	if (i === undefined) {
    		return this.getTokens(WireQueryParser.DOT);
    	} else {
    		return this.getToken(WireQueryParser.DOT, i);
    	}
    }
    public override get ruleIndex(): number {
        return WireQueryParser.RULE_fieldPath;
    }
    public override enterRule(listener: WireQueryListener): void {
        if(listener.enterFieldPath) {
             listener.enterFieldPath(this);
        }
    }
    public override exitRule(listener: WireQueryListener): void {
        if(listener.exitFieldPath) {
             listener.exitFieldPath(this);
        }
    }
    public override accept<Result>(visitor: WireQueryVisitor<Result>): Result | null {
        if (visitor.visitFieldPath) {
            return visitor.visitFieldPath(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class PredicateContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public orPredicate(): OrPredicateContext {
        return this.getRuleContext(0, OrPredicateContext)!;
    }
    public override get ruleIndex(): number {
        return WireQueryParser.RULE_predicate;
    }
    public override enterRule(listener: WireQueryListener): void {
        if(listener.enterPredicate) {
             listener.enterPredicate(this);
        }
    }
    public override exitRule(listener: WireQueryListener): void {
        if(listener.exitPredicate) {
             listener.exitPredicate(this);
        }
    }
    public override accept<Result>(visitor: WireQueryVisitor<Result>): Result | null {
        if (visitor.visitPredicate) {
            return visitor.visitPredicate(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class OrPredicateContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public andPredicate(): AndPredicateContext[];
    public andPredicate(i: number): AndPredicateContext | null;
    public andPredicate(i?: number): AndPredicateContext[] | AndPredicateContext | null {
        if (i === undefined) {
            return this.getRuleContexts(AndPredicateContext);
        }

        return this.getRuleContext(i, AndPredicateContext);
    }
    public OR(): antlr.TerminalNode[];
    public OR(i: number): antlr.TerminalNode | null;
    public OR(i?: number): antlr.TerminalNode | null | antlr.TerminalNode[] {
    	if (i === undefined) {
    		return this.getTokens(WireQueryParser.OR);
    	} else {
    		return this.getToken(WireQueryParser.OR, i);
    	}
    }
    public override get ruleIndex(): number {
        return WireQueryParser.RULE_orPredicate;
    }
    public override enterRule(listener: WireQueryListener): void {
        if(listener.enterOrPredicate) {
             listener.enterOrPredicate(this);
        }
    }
    public override exitRule(listener: WireQueryListener): void {
        if(listener.exitOrPredicate) {
             listener.exitOrPredicate(this);
        }
    }
    public override accept<Result>(visitor: WireQueryVisitor<Result>): Result | null {
        if (visitor.visitOrPredicate) {
            return visitor.visitOrPredicate(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class AndPredicateContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public notPredicate(): NotPredicateContext[];
    public notPredicate(i: number): NotPredicateContext | null;
    public notPredicate(i?: number): NotPredicateContext[] | NotPredicateContext | null {
        if (i === undefined) {
            return this.getRuleContexts(NotPredicateContext);
        }

        return this.getRuleContext(i, NotPredicateContext);
    }
    public AND(): antlr.TerminalNode[];
    public AND(i: number): antlr.TerminalNode | null;
    public AND(i?: number): antlr.TerminalNode | null | antlr.TerminalNode[] {
    	if (i === undefined) {
    		return this.getTokens(WireQueryParser.AND);
    	} else {
    		return this.getToken(WireQueryParser.AND, i);
    	}
    }
    public override get ruleIndex(): number {
        return WireQueryParser.RULE_andPredicate;
    }
    public override enterRule(listener: WireQueryListener): void {
        if(listener.enterAndPredicate) {
             listener.enterAndPredicate(this);
        }
    }
    public override exitRule(listener: WireQueryListener): void {
        if(listener.exitAndPredicate) {
             listener.exitAndPredicate(this);
        }
    }
    public override accept<Result>(visitor: WireQueryVisitor<Result>): Result | null {
        if (visitor.visitAndPredicate) {
            return visitor.visitAndPredicate(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class NotPredicateContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public NOT(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.NOT, 0);
    }
    public notPredicate(): NotPredicateContext | null {
        return this.getRuleContext(0, NotPredicateContext);
    }
    public predicateAtom(): PredicateAtomContext | null {
        return this.getRuleContext(0, PredicateAtomContext);
    }
    public override get ruleIndex(): number {
        return WireQueryParser.RULE_notPredicate;
    }
    public override enterRule(listener: WireQueryListener): void {
        if(listener.enterNotPredicate) {
             listener.enterNotPredicate(this);
        }
    }
    public override exitRule(listener: WireQueryListener): void {
        if(listener.exitNotPredicate) {
             listener.exitNotPredicate(this);
        }
    }
    public override accept<Result>(visitor: WireQueryVisitor<Result>): Result | null {
        if (visitor.visitNotPredicate) {
            return visitor.visitNotPredicate(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class PredicateAtomContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public LPAREN(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.LPAREN, 0);
    }
    public predicate(): PredicateContext | null {
        return this.getRuleContext(0, PredicateContext);
    }
    public RPAREN(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.RPAREN, 0);
    }
    public expression(): ExpressionContext[];
    public expression(i: number): ExpressionContext | null;
    public expression(i?: number): ExpressionContext[] | ExpressionContext | null {
        if (i === undefined) {
            return this.getRuleContexts(ExpressionContext);
        }

        return this.getRuleContext(i, ExpressionContext);
    }
    public comparison(): ComparisonContext | null {
        return this.getRuleContext(0, ComparisonContext);
    }
    public IS(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.IS, 0);
    }
    public NULL_LITERAL(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.NULL_LITERAL, 0);
    }
    public NOT(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.NOT, 0);
    }
    public override get ruleIndex(): number {
        return WireQueryParser.RULE_predicateAtom;
    }
    public override enterRule(listener: WireQueryListener): void {
        if(listener.enterPredicateAtom) {
             listener.enterPredicateAtom(this);
        }
    }
    public override exitRule(listener: WireQueryListener): void {
        if(listener.exitPredicateAtom) {
             listener.exitPredicateAtom(this);
        }
    }
    public override accept<Result>(visitor: WireQueryVisitor<Result>): Result | null {
        if (visitor.visitPredicateAtom) {
            return visitor.visitPredicateAtom(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class ExpressionContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public fieldPath(): FieldPathContext | null {
        return this.getRuleContext(0, FieldPathContext);
    }
    public literal(): LiteralContext | null {
        return this.getRuleContext(0, LiteralContext);
    }
    public aggregateCall(): AggregateCallContext | null {
        return this.getRuleContext(0, AggregateCallContext);
    }
    public override get ruleIndex(): number {
        return WireQueryParser.RULE_expression;
    }
    public override enterRule(listener: WireQueryListener): void {
        if(listener.enterExpression) {
             listener.enterExpression(this);
        }
    }
    public override exitRule(listener: WireQueryListener): void {
        if(listener.exitExpression) {
             listener.exitExpression(this);
        }
    }
    public override accept<Result>(visitor: WireQueryVisitor<Result>): Result | null {
        if (visitor.visitExpression) {
            return visitor.visitExpression(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class ComparisonContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public EQ(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.EQ, 0);
    }
    public NE(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.NE, 0);
    }
    public LT(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.LT, 0);
    }
    public LE(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.LE, 0);
    }
    public GT(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.GT, 0);
    }
    public GE(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.GE, 0);
    }
    public override get ruleIndex(): number {
        return WireQueryParser.RULE_comparison;
    }
    public override enterRule(listener: WireQueryListener): void {
        if(listener.enterComparison) {
             listener.enterComparison(this);
        }
    }
    public override exitRule(listener: WireQueryListener): void {
        if(listener.exitComparison) {
             listener.exitComparison(this);
        }
    }
    public override accept<Result>(visitor: WireQueryVisitor<Result>): Result | null {
        if (visitor.visitComparison) {
            return visitor.visitComparison(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class LiteralContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public STRING(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.STRING, 0);
    }
    public DECIMAL(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.DECIMAL, 0);
    }
    public INTEGER(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.INTEGER, 0);
    }
    public PLUS(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.PLUS, 0);
    }
    public MINUS(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.MINUS, 0);
    }
    public TRUE_LITERAL(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.TRUE_LITERAL, 0);
    }
    public FALSE_LITERAL(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.FALSE_LITERAL, 0);
    }
    public NULL_LITERAL(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.NULL_LITERAL, 0);
    }
    public override get ruleIndex(): number {
        return WireQueryParser.RULE_literal;
    }
    public override enterRule(listener: WireQueryListener): void {
        if(listener.enterLiteral) {
             listener.enterLiteral(this);
        }
    }
    public override exitRule(listener: WireQueryListener): void {
        if(listener.exitLiteral) {
             listener.exitLiteral(this);
        }
    }
    public override accept<Result>(visitor: WireQueryVisitor<Result>): Result | null {
        if (visitor.visitLiteral) {
            return visitor.visitLiteral(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class OwnerNameContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public STRING(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.STRING, 0);
    }
    public identifier(): IdentifierContext | null {
        return this.getRuleContext(0, IdentifierContext);
    }
    public override get ruleIndex(): number {
        return WireQueryParser.RULE_ownerName;
    }
    public override enterRule(listener: WireQueryListener): void {
        if(listener.enterOwnerName) {
             listener.enterOwnerName(this);
        }
    }
    public override exitRule(listener: WireQueryListener): void {
        if(listener.exitOwnerName) {
             listener.exitOwnerName(this);
        }
    }
    public override accept<Result>(visitor: WireQueryVisitor<Result>): Result | null {
        if (visitor.visitOwnerName) {
            return visitor.visitOwnerName(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class IdentifierContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public IDENTIFIER(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.IDENTIFIER, 0);
    }
    public QUOTED_IDENTIFIER(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.QUOTED_IDENTIFIER, 0);
    }
    public OWNER(): antlr.TerminalNode | null {
        return this.getToken(WireQueryParser.OWNER, 0);
    }
    public override get ruleIndex(): number {
        return WireQueryParser.RULE_identifier;
    }
    public override enterRule(listener: WireQueryListener): void {
        if(listener.enterIdentifier) {
             listener.enterIdentifier(this);
        }
    }
    public override exitRule(listener: WireQueryListener): void {
        if(listener.exitIdentifier) {
             listener.exitIdentifier(this);
        }
    }
    public override accept<Result>(visitor: WireQueryVisitor<Result>): Result | null {
        if (visitor.visitIdentifier) {
            return visitor.visitIdentifier(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}
